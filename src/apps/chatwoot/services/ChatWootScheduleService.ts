import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { QueueName } from '../consumers/QueueName';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ContactsPullRemove } from '@waha/apps/chatwoot/cli/cmd.contacts';
import { MessagesPullRemove } from '@waha/apps/chatwoot/cli/cmd.messages';

/**
 * Service for scheduling ChatWoot tasks
 * This service is used to schedule periodic tasks for ChatWoot
 */
@Injectable()
export class ChatWootScheduleService {
  constructor(
    @InjectPinoLogger('DashboardConfigService')
    protected logger: PinoLogger,
    @InjectQueue(QueueName.SCHEDULED_MESSAGE_CLEANUP)
    private readonly messageCleanupQueue: Queue,
    @InjectQueue(QueueName.SCHEDULED_CHECK_VERSION)
    private readonly checkVersionQueue: Queue,
    @InjectQueue(QueueName.TASK_CONTACTS_PULL)
    private readonly contactsPullQueue: Queue,
    @InjectQueue(QueueName.TASK_MESSAGES_PULL)
    private readonly messagesPullQueue: Queue,
  ) {}

  /**
   * Schedule periodic tasks for a ChatWoot app
   * @param appId The ID of the app
   * @param sessionName The name of the session
   */
  async schedule(appId: string, sessionName: string): Promise<void> {
    // Message Cleanup
    await this.messageCleanupQueue.upsertJobScheduler(
      this.JobId(QueueName.SCHEDULED_MESSAGE_CLEANUP, appId),
      // Every day at 17:00
      { pattern: '0 0 17 * * *' },
      {
        data: {
          app: appId,
          session: sessionName,
        },
      },
    );
    // Check the version
    await this.checkVersionQueue.upsertJobScheduler(
      this.JobId(QueueName.SCHEDULED_CHECK_VERSION, appId),
      // Every Wednesday (3) at 18:00
      { pattern: '0 0 18 * * 3' },
      {
        data: {
          app: appId,
          session: sessionName,
        },
      },
    );
  }

  async unschedule(appId: string, sessionName: string): Promise<void> {
    // Message Cleanup
    await this.messageCleanupQueue.removeJobScheduler(
      this.JobId(QueueName.SCHEDULED_MESSAGE_CLEANUP, appId),
    );
    // Check the version
    await this.checkVersionQueue.removeJobScheduler(
      this.JobId(QueueName.SCHEDULED_CHECK_VERSION, appId),
    );

    // contacts
    ContactsPullRemove(this.contactsPullQueue, appId, this.logger).catch(
      (reason) => {
        // Ignore errors
        this.logger.warn(
          `Failed to remove "contacts" job for app ${appId}, session ${sessionName}: ${reason}`,
        );
      },
    );

    MessagesPullRemove(this.messagesPullQueue, appId, this.logger).catch(
      (reason) => {
        this.logger.warn(
          `Failed to remove "messages" job for app ${appId}, session ${sessionName}: ${reason}`,
        );
      },
    );
  }

  /**
   * DEPRECATED - for backward compatability
   * Use SingleJobId if you want to have single job in the queue by app
   */
  private JobId(queue: QueueName, appId: string) {
    return `${queue} | ${appId}`;
  }

  static SingleJobId(appId: string) {
    return `${appId}`;
  }
}
