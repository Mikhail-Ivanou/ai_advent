import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // Uploaded documents for RAG indexing arrive base64-encoded in JSON (Day 21).
  app.useBodyParser('json', { limit: '50mb' });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Advent backend running on http://localhost:${port}`);
}

bootstrap();
