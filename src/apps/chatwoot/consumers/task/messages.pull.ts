import { Processor } from '@nestjs/bullmq';
import * as ms from 'ms';
import { JOB_CONCURRENCY } from '@waha/apps/app_sdk/constants';
import { JobLink } from '@waha/apps/app_sdk/JobUtils';
import { QueueName } from '@waha/apps/chatwoot/consumers/QueueName';
import { ChatWootTaskConsumer } from '@waha/apps/chatwoot/consumers/task/base';
import { DIContainer } from '@waha/apps/chatwoot/di/DIContainer';
import { Locale } from '@waha/apps/chatwoot/i18n/locale';
import { TKey } from '@waha/apps/chatwoot/i18n/templates';
import { SessionManager } from '@waha/core/abc/manager.abc';
import { RMutexService } from '@waha/modules/rmutex/rmutex.service';
import { Job, JobState } from 'bullmq';
import * as lodash from 'lodash';
import { PinoLogger } from 'nestjs-pino';
import { WAHASessionAPI } from '@waha/apps/app_sdk/waha/WAHASelf';
import { Conversation } from '@waha/apps/chatwoot/client/Conversation';
import { ILogger } from '@waha/apps/app_sdk/ILogger';
import {
  GetChatMessagesFilter,
  GetChatMessagesQuery,
  MessageSortField,
} from '@waha/structures/chats.dto';
import { WAMessage } from '@waha/structures/responses.dto';
import { EnsureSeconds } from '@waha/utils/timehelper';
import { MessageAnyHandler } from '@waha/apps/chatwoot/consumers/waha/message.any';
import { MessageReportInfo } from '@waha/apps/chatwoot/consumers/waha/base';
import { MessageAckEmoji } from '@waha/apps/chatwoot/emoji';
import { SortOrder } from '@waha/structures/pagination.dto';
import {
  ArrayPaginator,
  PaginatorParams,
} from '@waha/apps/app_sdk/waha/Paginator';
import { EngineHelper } from '@waha/apps/chatwoot/waha/engines';
import { IgnoreJidConfig, isNullJid, JidFilter } from '@waha/core/utils/jids';
import { ErrorRenderer } from '@waha/apps/chatwoot/error/ErrorRenderer';
import { IsCommandsChat } from '@waha/apps/chatwoot/client/ids';
import { CommandPrefix } from '@waha/apps/chatwoot/cli';
import { QueueManager } from '@waha/apps/chatwoot/services/QueueManager';

export enum ChatID {
  ALL = 'all',
  SUMMARY = 'summary',
}

export type MessagesPullOptions = {
  chat: string;
  batch: number;
  progress: number | null;
  period: {
    start: number;
    end: number;
  };
  force: boolean;
  pause: boolean;
  timeout: {
    media: number;
  };
  media: boolean;
  ignore: IgnoreJidConfig;
};

interface Progress {
  ok: number;
  exists: number;
  ignored: number;
  errors: number;
  chats: string[];
  last?: number;
}

const NullProgress: Progress = {
  ok: 0,
  exists: 0,
  ignored: 0,
  errors: 0,
  chats: [],
};

function total(progress: Progress) {
  return progress.ok + progress.exists + progress.ignored + progress.errors;
}

/**
 * Placeholder task consumer for pulling WhatsApp messages.
 * Throws until the implementation is completed.
 */
@Processor(QueueName.TASK_MESSAGES_PULL, { concurrency: JOB_CONCURRENCY })
export class TaskMessagesPullConsumer extends ChatWootTaskConsumer {
  constructor(
    manager: SessionManager,
    log: PinoLogger,
    rmutex: RMutexService,
    protected queueManager: QueueManager,
  ) {
    super(manager, log, rmutex, TaskMessagesPullConsumer.name);
  }

  protected ErrorHeaderKey(): TKey | null {
    return null;
  }

  protected async Process(
    container: DIContainer,
    job: Job,
    signal: AbortSignal,
  ) {
    const options: MessagesPullOptions = job.data.options;
    const locale = container.Locale();
    const conversation = this.conversationForReport(container, job.data.body);
    const waha = container.WAHASelf();
    const session = new WAHASessionAPI(job.data.session, waha);
    const handler = new MessagesPullHandler(
      this.queueManager,
      container,
      signal,
      container.Logger(),
      conversation,
      session,
      locale,
    );
    await handler.start(options, job);
    job = await handler.handle(options, job);
    return await handler.end(options, job);
  }
}

class MessagesPullHandler {
  private activity: TaskActivity;

  constructor(
    protected queueManager: QueueManager,
    protected container: DIContainer,
    protected signal: AbortSignal,
    protected logger: ILogger,
    conversation: Conversation,
    protected session: WAHASessionAPI,
    protected l: Locale,
  ) {
    this.activity = new TaskActivity(l, conversation);
  }

  /**
   * Calculate summary progress including current task and direct children
   */
  protected async summaryProgress(job: Job): Promise<Progress> {
    const current = lodash.merge({}, NullProgress, job.progress);
    const childrenValues = await job.getChildrenValues();
    const values: Progress[] = [current, ...Object.values(childrenValues)];
    let progress = lodash.merge({}, NullProgress);

    // Result
    for (const p of values) {
      progress.ok += p.ok;
      progress.exists += p.exists;
      progress.ignored += p.ignored;
      progress.errors += p.errors;
    }
    // Chats
    progress.chats = lodash.uniq(lodash.flatten(values.map((p) => p.chats)));
    // Last timestamp
    progress.last = lodash.max(values.map((p) => p.last || 0));
    if (progress.last === 0) {
      progress.last = undefined;
    }
    return progress;
  }

  async start(options: MessagesPullOptions, job: Job) {
    const { ignored, processed, unprocessed, failed } =
      await job.getDependenciesCount();
    const total = ignored + processed + unprocessed + failed;
    const hasChildren = total > 0;
    if (hasChildren) {
      return;
    }

    // Perform some actions before any job started
    if (options.pause) {
      await this.queueManager.pause();
      await this.activity.queue(true);
    }
  }

  async end(options: MessagesPullOptions, job: Job) {
    if (job.parentKey) {
      return await this.summaryProgress(job);
    }
    // Perform some actions after all jobs are done
    const progress = await this.summaryProgress(job);
    await job.updateProgress(progress);
    await this.activity.completed(progress, options);
    if (options.pause) {
      await this.queueManager.resume();
      await this.activity.queue(false);
    }
    return progress;
  }

  async handle(options: MessagesPullOptions, job: Job): Promise<Job> {
    if (options.chat === ChatID.SUMMARY) {
      // Do nothing for "summary" chat
      return job;
    }
    const jids = new JidFilter(options.ignore);
    let progress = lodash.merge({}, NullProgress, job.progress);
    const batch = options.batch ?? 100;

    this.logger.debug(
      `Pulling messages for session ${job.data.session} with batch size ${batch}...`,
    );
    if (lodash.isEqual(progress, NullProgress)) {
      await this.activity.started(job, options);
    }

    // Handler
    const container = this.container;
    const info = new MessageReportInfo();
    const handler = new MessageAnyHistoryHandler(
      job,
      container.MessageMappingService(),
      container.ContactConversationService(),
      container.Logger(),
      info,
      this.session,
      container.Locale(),
      container.WAHASelf(),
    );
    handler.force = options.force;

    // Messages
    const lte = job.timestamp - options.period.end;
    const gte = job.timestamp - options.period.start;
    const filters: GetChatMessagesFilter = {
      'filter.timestamp.lte': EnsureSeconds(lte),
      'filter.timestamp.gte': EnsureSeconds(gte),
    };

    const query: GetChatMessagesQuery = {
      limit: batch,
      offset: 0,
      downloadMedia: false,
      sortBy: MessageSortField.TIMESTAMP,
      sortOrder: SortOrder.ASC,
    };
    const params: PaginatorParams = {
      processed: total(progress),
    };
    const paginator = new ArrayPaginator<WAMessage>(params);
    let messages = paginator.iterate((processed: number) => {
      query.offset = processed;
      return this.session.getMessages(options.chat, query, filters, {
        signal: this.signal,
      });
    });

    messages = EngineHelper.IterateMessages(messages);
    const all = options.chat == ChatID.ALL;

    for await (let message of messages) {
      this.signal.throwIfAborted();

      //
      // Show progress
      //
      const thetotal = total(progress);
      if (options.progress && thetotal) {
        if (thetotal % options.progress == 0) {
          await this.activity.progress(progress, options);
        }
      }

      // Process
      try {
        progress.last = message.timestamp;
        if (all && !jids.include(EngineHelper.ChatID(message))) {
          progress.ignored += 1;
          continue;
        }

        if (isNullJid(EngineHelper.ChatID(message))) {
          progress.ignored += 1;
          continue;
        }

        if (
          options.media &&
          message.hasMedia &&
          (await handler.ShouldProcessMessage(message))
        ) {
          // Fetch media for the message
          let signal = AbortSignal.timeout(options.timeout.media);
          signal = AbortSignal.any([signal, this.signal]);
          message = await this.session.getMessageById('all', message.id, true, {
            signal: signal,
          });
        }

        const chatwoot = await handler.handle(message);
        progress.ok += chatwoot ? 1 : 0;
        progress.exists += chatwoot ? 0 : 1;
        if (
          chatwoot &&
          !progress.chats.includes(EngineHelper.ChatID(message))
        ) {
          progress.chats.push(EngineHelper.ChatID(message));
        }
      } catch (error) {
        const renderer = new ErrorRenderer();
        const text = renderer.text(error);
        this.logger.error(`Error: ${text}`);
        this.logger.error(`Message:\n${JSON.stringify(message, null, 2)}`);
        try {
          const data = renderer.data(error);
          this.logger.error(JSON.stringify(data, null, 2));
        } catch (err) {
          this.logger.error(
            `Error occurred while login details for error: ${err}`,
          );
        }
        progress.errors += 1;
      }
      // update progress before signal fails
      await job.updateProgress(progress);
    }
    job.progress = progress;
    return job;
  }
}

export class TaskActivity {
  constructor(
    private l: Locale,
    private conversation: Conversation,
  ) {}

  public async queue(paused: boolean) {
    let msg: string;
    if (paused) {
      msg = this.l.r('cli.cmd.queue.paused');
    } else {
      msg = this.l.r('cli.cmd.queue.resumed');
    }
    await this.conversation.activity(msg);
  }

  public async details(data) {
    await this.conversation.activity(
      this.l.r('task.messages.details', {
        prefix: IsCommandsChat(data.body) ? '' : CommandPrefix,
      }),
    );
  }

  public async started(job: Job, options: MessagesPullOptions) {
    await this.conversation.activity(
      this.l.r('task.messages.started', {
        chat: options.chat,
        period: period(options),
      }),
    );
  }

  public async progress(progress: Progress, options: MessagesPullOptions) {
    const format: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };
    await this.conversation.activity(
      this.l.r('task.messages.progress', {
        progress: progress,
        chat: options.chat,
        last: this.l.FormatTimestampOpts(progress.last, format, false),
      }),
    );
  }

  /**
   * Final report
   */
  public async completed(progress, options) {
    const msg = this.l.r('task.messages.completed', {
      progress: progress,
      period: period(options),
      chat: options.chat,
    });
    await this.conversation.activity(msg);
  }
}

class MessageAnyHistoryHandler extends MessageAnyHandler {
  public force: boolean = false;
  public shouldLogUnsupported = true;

  protected get shouldAddFromTag() {
    return false;
  }

  protected get delayFromMeAPI() {
    return 0;
  }

  async ShouldProcessMessage(payload: WAMessage) {
    if (this.force) {
      return true;
    }
    return await super.ShouldProcessMessage(payload);
  }

  protected finalizeContent(content: string, payload: WAMessage): string {
    let ack: any = null;
    if (payload.fromMe) {
      ack = {
        emoji: MessageAckEmoji(payload.ack),
        name: this.l.r(payload.ackName || 'UNKNOWN'),
      };
    }
    return this.l.r('whatsapp.history.message.wrapper', {
      content: content,
      payload: payload,
      timestamp: this.l.FormatTimestamp(payload.timestamp, false),
      ack: ack,
    });
  }
}

function period(options: MessagesPullOptions) {
  const start = options.period.start;
  const end = options.period.end;
  if (end == 0) {
    return ms(start);
  }
  return `${ms(start)}-${ms(end)}`;
}

export function MessagesPullStatusMessage(
  l: Locale,
  job: Job,
  state: JobState | 'unknown',
) {
  const progress = lodash.merge({}, NullProgress, job.progress);
  const details = JobLink(job);
  const options = job.data.options as MessagesPullOptions;
  const payload = {
    chat: options.chat,
    chats: progress.chats.length,
    period: period(options),
    error: state === 'failed' || state === 'unknown' || progress.errors > 0,
    state: lodash.capitalize(state ?? 'unknown'),
    progress: progress,
    details: details,
    last: l.FormatTimestamp(progress.last, false),
  };

  return l.r('task.messages.status', payload);
}
