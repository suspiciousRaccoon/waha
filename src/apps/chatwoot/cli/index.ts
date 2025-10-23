import {
  Argument,
  Command,
  CommanderError,
  Option,
  OutputConfiguration,
} from 'commander';
import argvSplit from 'string-argv';
import { BufferedOutput } from '@waha/apps/chatwoot/cli/utils/BufferedOutput';
import {
  buildFormatHelp,
  fullCommandPath,
} from '@waha/apps/chatwoot/cli/utils/help';
import {
  JobAttemptsOption,
  JobTimeoutOption,
  ParseMS,
} from '@waha/apps/chatwoot/cli/utils/options';
import { CommandContext } from '@waha/apps/chatwoot/cli/types';
import {
  SessionLogout,
  SessionQR,
  SessionRestart,
  SessionScreenshot,
  SessionStart,
  SessionStatus,
  SessionStop,
} from '@waha/apps/chatwoot/cli/cms.session';
import { ServerReboot, ServerStatus } from '@waha/apps/chatwoot/cli/cmd.server';
import { ChatWootCommandsConfig } from '@waha/apps/chatwoot/dto/config.dto';
import { CommandDisabled } from '@waha/apps/chatwoot/cli/cmd.disabled';
import {
  ContactsPullStart,
  ContactsPullStatus,
} from '@waha/apps/chatwoot/cli/cmd.contacts';
import { ContactsPullOptions } from '@waha/apps/chatwoot/consumers/task/contacts.pull';
import { JobsOptions } from 'bullmq';
import { JobDataTimeout } from '@waha/apps/app_sdk/AppConsumer';

function BuildProgram(
  commands: ChatWootCommandsConfig,
  ctx: CommandContext,
  output: OutputConfiguration,
) {
  const l = ctx.l;
  const SessionGroup = l.r('cli.cmd.root.sub.session');
  const ServerGroup = l.r('cli.cmd.root.sub.server');
  const SyncGroup = l.r('cli.cmd.root.sub.sync');

  const program = new Command();
  program
    .name('')
    .description(l.r('cli.cmd.root.description'))
    .exitOverride()
    .configureOutput(output)
    .showSuggestionAfterError(true)
    .commandsGroup(SessionGroup)
    .commandsGroup(ServerGroup)
    .commandsGroup(SyncGroup)
    .configureHelp({
      helpWidth: 200,
      styleOptionTerm(str: string) {
        return `- \`${str}\``;
      },
      styleArgumentTerm(str: string) {
        return `- **${str}**`;
      },
      styleUsage(str) {
        return `**${str}**`;
      },
      styleSubcommandTerm(str: string) {
        return `- **${str}**`;
      },
      styleSubcommandDescription(str: string) {
        return str ? `- ${str}` : str;
      },
      subcommandTerm: fullCommandPath,
      commandUsage(cmd) {
        // For the root program - no usage
        if (!cmd.parent)
          return `${l.r('cli.usage.command')} ${l.r('cli.usage.options')}`;
        // For subcommands, keep default behavior
        if (cmd.commands.length > 0) {
          return `${fullCommandPath(cmd)} ${l.r('cli.usage.command')} ${l.r(
            'cli.usage.options',
          )}`;
        }
        return `${fullCommandPath(cmd)} ${l.r('cli.usage.options')}`;
      },
      formatHelp: buildFormatHelp(l),
    });

  //
  // Session
  //
  program
    .command('status')
    .alias('1')
    .description(l.r('cli.cmd.session.status.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionStatus(ctx));
  program
    .command('restart')
    .alias('2')
    .description(l.r('cli.cmd.session.restart.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionRestart(ctx));
  program
    .command('start')
    .alias('3')
    .description(l.r('cli.cmd.session.start.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionStart(ctx));
  program
    .command('stop')
    .alias('4')
    .description(l.r('cli.cmd.session.stop.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionStop(ctx));
  program
    .command('logout')
    .alias('5')
    .description(l.r('cli.cmd.session.logout.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionLogout(ctx));
  program
    .command('qr')
    .alias('6')
    .description(l.r('cli.cmd.session.qr.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionQR(ctx));
  program
    .command('screenshot')
    .alias('7')
    .description(l.r('cli.cmd.session.screenshot.description'))
    .helpGroup(SessionGroup)
    .action(() => SessionScreenshot(ctx));

  //
  // Pull Contacts
  //
  program
    .command('contacts')
    .alias('/contacts')
    .summary(l.r('cli.cmd.contacts.summary'))
    .description(l.r('cli.cmd.contacts.description'))
    .helpGroup(SyncGroup)
    .addArgument(
      new Argument(
        '[action]',
        l.r('cli.cmd.contacts.action.description'),
      ).choices(['pull', 'status']),
    )
    .addOption(
      new Option('--avatar <mode>', l.r('cli.cmd.contacts.pull.option.avatar'))
        .choices(['skip', 'if-missing', 'update'])
        .default('if-missing'),
    )
    .option('--groups', l.r('cli.cmd.contacts.pull.option.groups'))
    .option('--no-lids', l.r('cli.cmd.contacts.pull.option.no-lids'))
    .option(
      '--no-attributes',
      l.r('cli.cmd.contacts.pull.option.no-attributes'),
    )
    .option(
      '--batch <number>',
      l.r('cli.cmd.contacts.pull.option.batch'),
      100 as any,
    )
    .addOption(new JobAttemptsOption(l, 6))
    .addOption(new JobTimeoutOption(l, '10m'))
    .addOption(
      new Option(
        '--delay-contact <duration>',
        l.r('cli.cmd.contacts.pull.option.delay-contact'),
      )
        .argParser(ParseMS)
        .default(ParseMS('0.1s'), '0.1s'),
    )
    .addOption(
      new Option(
        '--delay-batch <duration>',
        l.r('cli.cmd.contacts.pull.option.delay-batch'),
      )
        .argParser(ParseMS)
        .default(ParseMS('1s'), '1s'),
    )
    .action(async (action, opts, cmd: Command) => {
      if (!action) {
        cmd.outputHelp();
        return;
      }

      if (action === 'status') {
        await ContactsPullStatus(ctx);
        return;
      }

      const options: ContactsPullOptions = {
        batch: opts.batch,
        avatar: opts.avatar,
        attributes: opts.attributes,
        contacts: {
          lids: opts.lids,
          groups: opts.groups,
        },
        delay: {
          contact: opts.delayContact,
          batch: opts.delayBatch,
        },
      };
      const jobOptions: JobsOptions & JobDataTimeout = {
        attempts: opts.attempts,
        timeout: {
          job: opts.timeout,
        },
      };
      await ContactsPullStart(ctx, options, jobOptions);
    });

  //
  // Server
  //
  const server = program
    .command('server', { hidden: !commands.server })
    .description(l.r('cli.cmd.server.description'))
    .helpGroup(ServerGroup);
  if (!commands.server) {
    // Do not show help, show disabled ASAP
    server.action(() => CommandDisabled(ctx, 'server'));
  }
  server
    .command('status')
    .description(l.r('cli.cmd.server.status.description'))
    .action(() =>
      commands.server
        ? ServerStatus(ctx)
        : CommandDisabled(ctx, 'server status'),
    );
  server
    .command('reboot')
    .description(l.r('cli.cmd.server.reboot.description'))
    .option('-f, --force', l.r('cli.cmd.server.reboot.option.force'), false)
    .action((opts) =>
      commands.server
        ? ServerReboot(ctx, opts.force)
        : CommandDisabled(ctx, 'server reboot'),
    );
  return program;
}

export async function runText(
  commands: ChatWootCommandsConfig,
  ctx: CommandContext,
  text: string,
) {
  // Prepare text for cli like command
  text = text
    .split('\n') // split into lines
    .map((line) => line.trimStart()) // remove indentation
    .join(' ') // join with space
    .trim(); // final cleanup
  const output = new BufferedOutput();
  const program = BuildProgram(commands, ctx, output);
  const argv = argvSplit(text, '', '');
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return output;
    } else {
      throw err; // unexpected bug in your action code
    }
  }
  return output;
}
