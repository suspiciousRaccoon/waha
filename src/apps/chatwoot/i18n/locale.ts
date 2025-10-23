import * as Mustache from 'mustache';
import { TemplatePayloads, TKey } from '@waha/apps/chatwoot/i18n/templates';
import Long from 'long';
import { ensureNumber } from '@waha/core/engines/noweb/utils';

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

  FormatDatetime(date: Date | null): string | null {
    if (!date) {
      return null;
    }
    const options: any = this.strings['datetime'] || {};
    options.timeZone = options.timeZone || options.timezone || process.env.TZ;
    return date.toLocaleString(this.locale, options);
  }

  FormatDatetimeSec(date: Date | null) {
    if (!date) {
      return null;
    }
    const options: any = this.strings['datetime'] || {};
    options.second = '2-digit';
    options.timeZone = options.timeZone || options.timezone || process.env.TZ;
    return date.toLocaleString(this.locale, options);
  }

  FormatTimestampSec(timestamp: any) {
    const date = this.ParseTimestamp(timestamp);
    return this.FormatDatetimeSec(date);
  }

  ParseTimestamp(timestamp: Long | string | number | null): Date | null {
    const value = ensureNumber(timestamp);
    if (!value) {
      return undefined;
    }
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const milliseconds = value >= 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }
    return date;
  }

  FormatTimestamp(timestamp: Long | string | number | null): string | null {
    const date = this.ParseTimestamp(timestamp);
    return this.FormatDatetime(date);
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
