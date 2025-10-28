import * as Mustache from 'mustache';
import * as lodash from 'lodash';
import { TemplatePayloads, TKey } from '@waha/apps/chatwoot/i18n/templates';
import Long from 'long';
import { ensureNumber } from '@waha/core/engines/noweb/utils';
import { EnsureMilliseconds } from '@waha/utils/timehelper';

export class Locale {
  constructor(private readonly strings: Record<string, string>) {}

  /**
   * Return Base Locale
   * For number, datetime, currency formats
   */
  get locale(): string {
    return this.strings['locale.base'] || 'en';
  }

  key<K extends TKey>(key: K): Template<K> {
    return new Template(this.strings[key] || key);
  }

  r<K extends TKey | string>(key: K, data: TemplatePayloads[K] = null): string {
    const template = this.key(key as TKey);
    return template.render(data as any);
  }

  /**
   * Overrides the existing strings with the provided strings for the locale.
   * Merges the new strings with the current strings.
   */
  override(strings: Record<string, string>): Locale {
    return new Locale({ ...this.strings, ...strings });
  }

  FormatCurrency(
    currency: string,
    value: number | null,
    offset: number = 1,
  ): string | null {
    if (value == null) {
      return null;
    }
    if (!currency) {
      return null;
    }

    offset = offset || 1;
    try {
      const fmt = new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency: currency,
      });
      return fmt.format(value / offset);
    } catch (err) {
      return `${currency} ${value}`;
    }
  }

  FormatDatetime(date: Date | null, year): string | null {
    const options: any = lodash.clone(this.strings['datetime'] || {});
    return this.FormatDatetimeOpts(date, options, year);
  }

  ParseTimestamp(timestamp: Long | string | number | null): Date | null {
    const value = ensureNumber(timestamp);
    if (!value) {
      return undefined;
    }
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const milliseconds = EnsureMilliseconds(value);
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }
    return date;
  }

  FormatTimestamp(
    timestamp: Long | string | number | null,
    year: boolean = true,
  ): string | null {
    const date = this.ParseTimestamp(timestamp);
    return this.FormatDatetime(date, year);
  }

  /**
   * Format date using custom options
   */

  FormatDatetimeOpts(
    date: Date,
    options: Intl.DateTimeFormatOptions,
    year: boolean,
  ) {
    options = lodash.cloneDeep(options);
    if (!date) {
      return null;
    }
    const opts: any = this.strings['datetime'] || {};
    // Copy timezone if any
    options.timeZone = opts.timeZone || opts.timezone || process.env.TZ;
    if (!year && date.getFullYear() === new Date().getFullYear()) {
      // Hide year if current year
      options.year = undefined;
    }
    return date.toLocaleDateString(this.locale, options);
  }

  FormatTimestampOpts(
    timestamp: Long | string | number | null,
    options: Intl.DateTimeFormatOptions,
    year: boolean = true,
  ): string | null {
    const date = this.ParseTimestamp(timestamp);
    return this.FormatDatetimeOpts(date, options, year);
  }
}

export class Template<K extends TKey> {
  constructor(private readonly template: string) {}

  render(data: TemplatePayloads[K]): string {
    const text = Mustache.render(this.template, data);
    // Remove /n at the end if any
    return text.replace(/\n$/, '');
  }

  r(data: TemplatePayloads[K]): string {
    return this.render(data);
  }
}
