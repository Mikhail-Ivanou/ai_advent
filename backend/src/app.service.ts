import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStatus(): { message: string; day: number | null } {
    return {
      message: 'Advent backend is up',
      day: this.currentAdventDay(),
    };
  }

  private currentAdventDay(): number | null {
    const now = new Date();
    const isDecember = now.getMonth() === 11;
    return isDecember ? Math.min(now.getDate(), 25) : null;
  }
}
