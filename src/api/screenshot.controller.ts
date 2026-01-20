import {
  Controller,
  Get,
  Query,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiFileAcceptHeader } from '@waha/nestjs/ApiFileAcceptHeader';
import { Response } from 'express';

import { SessionManager } from '../core/abc/manager.abc';
import { BufferResponseInterceptor } from '../nestjs/BufferResponseInterceptor';
import { SessionQuery } from '../structures/base.dto';

@ApiSecurity('api_key')
@Controller('api')
@ApiTags('📱 Pairing')
export class ScreenshotController {
  constructor(private manager: SessionManager) {}

  @Get('/screenshot')
  @ApiOperation({
    summary:
      'Get a screenshot of the current WhatsApp session (**WEBJS** only)',
  })
  @UseInterceptors(new BufferResponseInterceptor('image/jpeg'))
  @ApiFileAcceptHeader('image/jpeg')
  async screenshot(
    @Res({ passthrough: true }) res: Response,
    @Query() sessionQuery: SessionQuery,
  ) {
    const whatsappService = this.manager.getSession(sessionQuery.session);
    return await whatsappService.getScreenshot();
  }
}
