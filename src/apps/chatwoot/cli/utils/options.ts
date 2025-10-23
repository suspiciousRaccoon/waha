import * as ms from 'ms';
import { Option } from 'commander';
import { Locale } from '@waha/apps/chatwoot/i18n/locale';

/**
 * Parse human string into milliseconds
 */
export function ParseMS(value: string) {
  const duration = ms(value);
  if (duration == null) throw new Error(`Invalid duration: "${value}"`);
  if (duration < 0) throw new Error(`Duration cannot be negative: "${value}"`);
  return duration;
}

export function ParseSeconds(value: string): number {
  const duration = ParseMS(value);
  return Math.floor(duration / 1000);
}

export class JobAttemptsOption extends Option {
  constructor(l: Locale, def: number) {
    super('--attempts <number>', l.r('cli.cmd.options.job.attempts'));
    this.default(def);
  }
}

export class JobTimeoutOption extends Option {
  constructor(l: Locale, def: string) {
    super('--timeout <duration>', l.r('cli.cmd.options.job.timeout'));
    this.argParser(ParseMS);
    this.default(ParseMS(def));
  }
}
