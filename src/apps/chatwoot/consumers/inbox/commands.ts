import { InjectQueue, Processor } from '@nestjs/bullmq';
import { JOB_CONCURRENCY } from '@waha/apps/app_sdk/constants';
import { ChatWootInboxMessageConsumer } from '@waha/apps/chatwoot/consumers/inbox/base';
import { QueueName } from '@waha/apps/chatwoot/consumers/QueueName';
import { DIContainer } from '@waha/apps/chatwoot/di/DIContainer';
import { SessionManager } from '@waha/core/abc/manager.abc';
import { RMutexService } from '@waha/modules/rmutex/rmutex.service';
import { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { TKey } from '@waha/apps/chatwoot/i18n/templates';
import { runText } from '@waha/apps/chatwoot/cli';
import { CommandContext } from '@waha/apps/chatwoot/cli/types';

@Processor(QueueName.INBOX_COMMANDS, { concurrency: JOB_CONCURRENCY })
export class ChatWootInboxCommandsConsumer extends ChatWootInboxMessageConsumer {
  constructor(
    protected readonly manager: SessionManager,
    log: PinoLogger,
    rmutex: RMutexService,
    @InjectQueue(QueueName.TASK_CONTACTS_PULL)
    private readonly importContactsQueue: Queue,
  ) {
    super(manager, log, rmutex, 'ChatWootInboxCommandsConsumer');
  }

  ErrorHeaderKey(): TKey | null {
    return null;
  }

  protected async Process(container: DIContainer, body, job: Job) {
    const cmd = body.content;
    this.logger.info(
      `Executing command '${cmd}' for session ${job.data.session}...`,
    );
    const repo = container.ContactConversationService();
    const conversation = await repo.InboxNotifications();

    const ctx: CommandContext = {
      app: job.data.app,
      session: job.data.session,
      logger: this.logger,
      l: container.Locale(),
      waha: container.WAHASelf(),
      conversation: conversation,
      queues: {
        importContacts: this.importContactsQueue,
      },
    };
    const commands = container.ChatWootConfig().commands;
    const output = await runText(commands, ctx, cmd);
    if (output.out) {
      await conversation.incoming(output.out);
    }
    if (output.err) {
      await conversation.incoming(output.err);
    }
  }
}
