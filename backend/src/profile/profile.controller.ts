import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { UserProfile, UserProfileInput } from './profile.types';

/** CRUD for user profiles — the explicit half of personalization (see ProfileService for how it's attached to requests). */
@Controller('profiles')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  list(): { profiles: UserProfile[] } {
    return { profiles: this.profileService.list() };
  }

  @Post()
  async create(@Body() body: UserProfileInput): Promise<UserProfile> {
    return this.profileService.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: Partial<UserProfileInput>): Promise<UserProfile> {
    return this.profileService.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.profileService.remove(id);
    return { deleted: true };
  }
}
