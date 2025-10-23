import { Processor } from '@nestjs/bullmq';
import * as lodash from 'lodash';
import { JOB_CONCURRENCY } from '@waha/apps/app_sdk/constants';
import { QueueName } from '@waha/apps/chatwoot/consumers/QueueName';
import { DIContainer } from '@waha/apps/chatwoot/di/DIContainer';
import { SessionManager } from '@waha/core/abc/manager.abc';
import { RMutexService } from '@waha/modules/rmutex/rmutex.service';
import { Job, JobState } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { ChatWootTaskConsumer } from '@waha/apps/chatwoot/consumers/task/base';
import { TKey } from '@waha/apps/chatwoot/i18n/templates';
import { WAHASessionAPI } from '@waha/apps/chatwoot/session/WAHASelf';
import { WhatsAppContactInfo } from '@waha/apps/chatwoot/contacts/WhatsAppContactInfo';
import { ContactSortField } from '@waha/structures/contacts.dto';
import { SortOrder } from '@waha/structures/pagination.dto';
import {
  AvatarUpdateMode,
  ContactService,
} from '@waha/apps/chatwoot/client/ContactService';
import { Conversation } from '@waha/apps/chatwoot/client/Conversation';
import { Locale } from '@waha/apps/chatwoot/i18n/locale';
import { ILogger } from '@waha/apps/app_sdk/ILogger';
import { JobLink } from '@waha/apps/app_sdk/JobUtils';
import { sleep } from '@waha/utils/promiseTimeout';
import { isJidGroup, isPnUser, isLidUser } from '@waha/core/utils/jids';

export interface ContactsPullOptions {
  batch: number;
  avatar: 'skip' | 'if-missing' | 'update';
  attributes: boolean;
  contacts: {
    groups: boolean;
    lids: boolean;
  };
  delay: {
    contact: number;
    batch: number;
  };
}

/**
 * Task consumer that pulls WhatsApp contacts into ChatWoot
 * Runs in batches to keep the job resumable and observable in ChatWoot
 */
@Processor(QueueName.TASK_CONTACTS_PULL, { concurrency: JOB_CONCURRENCY })
export class TaskContactsPullConsumer extends ChatWootTaskConsumer {
  constructor(manager: SessionManager, log: PinoLogger, rmutex: RMutexService) {
    super(manager, log, rmutex, TaskContactsPullConsumer.name);
  }

  protected ErrorHeaderKey(): TKey {
    return null;
  }

  /**
   * Process the contact pull job
   * Streams batches of contacts from WAHA into ChatWoot storage
   */
  protected async Process(
    container: DIContainer,
    job: Job,
    signal?: AbortSignal,
  ): Promise<any> {
    const options: ContactsPullOptions = job.data.options;
    const locale = container.Locale();
    const waha = container.WAHASelf();
    const session = new WAHASessionAPI(job.data.session, waha);
    const conversation = await container
      .ContactConversationService()
      .InboxNotifications();

    const handler = new ContactsPullHandler(
      signal,
      container.Logger(),
      conversation,
      session,
      locale,
      container.ContactService(),
    );
    return await handler.handle(options, job);
  }
}

interface Progress {
  ok: number;
  errors: number;
  skipped: number;
}

const NullProgress: Progress = {
  ok: 0,
  errors: 0,
  skipped: 0,
};

class ContactsPullHandler {
  constructor(
    private signal: AbortSignal,
    private logger: ILogger,
    private conversation: Conversation,
    private session: WAHASessionAPI,
    private l: Locale,
    private contactService: ContactService,
  ) {}

  async handle(options: ContactsPullOptions, job) {
    const batch = options.batch;
    let progress = lodash.merge({}, NullProgress, job.progress);
    this.logger.info(
      `Pulling contacts for session ${job.data.session} with batch size ${batch}...`,
    );
    if (progress.ok == 0 && progress.errors == 0 && progress.skipped == 0) {
      await this.conversation.activity(
        this.l.r('task.contacts.started', { progress: progress }),
      );
    } else {
      await this.conversation.activity(
        this.l.r('task.contacts.progress', { progress: progress }),
      );
    }

    // fake 'null' first, so it's not empty list
    // we overwrite it at the beginning of the loop
    let contacts: any[] = [null];
    while (contacts.length != 0) {
      this.signal.throwIfAborted();
      const processed = progress.ok + progress.errors + progress.skipped;
      this.logger.info(
        `Fetching contacts batch: offset=${processed}, limit=${batch}...`,
      );
      contacts = await this.session.getContacts(
        {
          offset: processed,
          limit: batch,
          sortBy: ContactSortField.ID,
          sortOrder: SortOrder.ASC,
        },
        { signal: this.signal },
      );

      for (const contact of contacts) {
        try {
          const chatId = contact.id;
          if (isJidGroup(chatId)) {
            if (!options.contacts.groups) {
              this.logger.info(`Skipping group contact ${chatId}...`);
              progress.skipped += 1;
              await job.updateProgress(progress);
              continue;
            }
          } else if (isLidUser(chatId)) {
            if (!options.contacts.lids) {
              this.logger.info(`Skipping PN contact ${chatId}...`);
              progress.skipped += 1;
              await job.updateProgress(progress);
              continue;
            }
            this.logger.info(`Skipping LID contact ${chatId}...`);
          } else if (!isPnUser(chatId)) {
            this.logger.info(`Skipping non-phone-number contact ${chatId}...`);
            progress.skipped += 1;
            await job.updateProgress(progress);
            continue;
          }

          this.logger.info(`Pulling ${chatId}...`);
          await this.pullOneContact(options, chatId);
          progress.ok += 1;
        } catch (e) {
          this.logger.error(`Error pulling contact ${contact.id}: ${e}`);
          progress.errors += 1;
          continue;
        }
        // update progress before signal fails
        await job.updateProgress(progress);
        this.signal.throwIfAborted();
        await sleep(options.delay.contact);
      }
      await this.conversation.activity(
        this.l.r('task.contacts.progress', { progress: progress }),
      );
      await sleep(options.delay.batch);
    }

    //
    // Final report
    //
    job.progress = progress;
    const msg = ContactsPullStatusMessage(this.l, job, 'completed');
    await this.conversation.incoming(msg);
  }

  private async pullOneContact(options: ContactsPullOptions, chatId: string) {
    // Contact
    const contactInfo = WhatsAppContactInfo(this.session, chatId, this.l);
    let cwContact = await this.contactService.findOrCreateContact(contactInfo);
    // Attributes
    if (options.attributes) {
      const attributes = await contactInfo.Attributes();
      await this.contactService.upsertCustomAttributes(
        cwContact.data,
        attributes,
      );
    }
    // Avatar
    switch (options.avatar) {
      case 'if-missing':
        await this.contactService.updateAvatar(
          cwContact,
          contactInfo,
          AvatarUpdateMode.IF_MISSING,
        );
        break;
      case 'update':
        await this.contactService.updateAvatar(
          cwContact,
          contactInfo,
          AvatarUpdateMode.ALWAYS,
        );
        break;
    }
  }
}

export function ContactsPullStatusMessage(
  l: Locale,
  job,
  state: JobState | 'unknown',
) {
  const details = JobLink(job);
  job.progress = lodash.merge({}, NullProgress, job.progress);
  const payload = {
    error: state === 'failed' || job.progress.errors > 0,
    state: lodash.capitalize(state),
    progress: job.progress,
    details: details,
    job: {
      timestamp: l.FormatTimestampSec(job.timestamp),
      processedOn: l.FormatTimestampSec(job.processedOn),
      finishedOn: l.FormatTimestampSec(job.finishedOn),
    },
  };
  return l.r('task.contacts.status', payload);
}
