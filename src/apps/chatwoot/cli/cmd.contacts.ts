import { CommandContext } from '@waha/apps/chatwoot/cli/types';
import { QueueName } from '@waha/apps/chatwoot/consumers/QueueName';
import {
  ContactsPullOptions,
  ContactsPullStatusMessage,
} from '@waha/apps/chatwoot/consumers/task/contacts.pull';
import { Job, JobsOptions, Queue } from 'bullmq';
import { ChatWootScheduleService } from '@waha/apps/chatwoot/services/ChatWootScheduleService';
import { ILogger } from '@waha/apps/app_sdk/ILogger';
import { JobDataTimeout } from '@waha/apps/app_sdk/AppConsumer';

export async function ContactsPullStart(
  ctx: CommandContext,
  options: ContactsPullOptions,
  jobOptions: JobsOptions & JobDataTimeout,
) {
  const jobId = ChatWootScheduleService.SingleJobId(ctx.app);
  const job: Job = await ctx.queues.importContacts.getJob(jobId);
  if (job) {
    const state = await job.getState();
    const done = state === 'completed' || state === 'failed';
    if (!done) {
      const msg = ctx.l.r('cli.cmd.contacts.pull.already-running');
      await ctx.conversation.incoming(msg);
      return;
    }

    // Remove already done job
    await ContactsPullRemove(ctx.queues.importContacts, ctx.app, ctx.logger);
  }

  const opts: JobsOptions = {
    ...jobOptions,
    jobId: jobId,
  };
  const data = {
    app: ctx.app,
    session: ctx.session,
    timeout: {
      job: jobOptions.timeout.job,
    },
    options: options,
  };
  await ctx.queues.importContacts.add(QueueName.TASK_CONTACTS_PULL, data, opts);

  const msg = ctx.l.r('cli.cmd.contacts.pull.queued', {
    batch: options.batch,
  });
  await ctx.conversation.incoming(msg);
}

export async function ContactsPullStatus(ctx: CommandContext) {
  const jobId = ChatWootScheduleService.SingleJobId(ctx.app);
  const job: Job | null = await ctx.queues.importContacts.getJob(jobId);

  if (!job) {
    const msg = ctx.l.r('cli.cmd.contacts.status.not-found');
    await ctx.conversation.incoming(msg);
    return;
  }
  const state = await job.getState();
  const msg = ContactsPullStatusMessage(ctx.l, job, state);
  await ctx.conversation.incoming(msg);
}

export async function ContactsPullRemove(
  queue: Queue,
  app: string,
  logger: ILogger,
): Promise<boolean> {
  const jobId = ChatWootScheduleService.SingleJobId(app);
  const job: Job = await queue.getJob(jobId);
  if (!job) {
    logger.info('Pull Contacts job has already been removed');
    return false;
  }
  await job.remove();
  return true;
}
