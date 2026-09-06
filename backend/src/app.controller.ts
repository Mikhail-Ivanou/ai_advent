import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getStatus(): { message: string; day: number | null } {
    return this.appService.getStatus();
  }

  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
