import { Injectable } from '@nestjs/common';
import { IncomingMessage } from 'http';
import * as url from 'url';
import { ApiKeyStrategy } from '@waha/core/auth/apiKey.strategy';

@Injectable()
export class WebSocketAuth {
  constructor(private strategy: ApiKeyStrategy) {}

  async validateRequest(request: IncomingMessage) {
    const apikey = this.getKeyFromQueryParams('x-api-key', request);
    return await this.strategy.user(apikey);
  }

  private getKeyFromQueryParams(name: string, request: IncomingMessage) {
    let query = url.parse(request.url, true).query;
    // case-insensitive query params
    query = Object.keys(query).reduce((acc, key) => {
      acc[key.toLowerCase()] = query[key];
      return acc;
    }, {});

    const provided = query[name];
    // Check if it's array - return first
    if (Array.isArray(provided)) {
      return provided[0];
    }
    return provided;
  }
}
