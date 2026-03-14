import { Module } from "@nestjs/common"
import { FeedCacheModule } from "../feed-cache/feed-cache.module"
import { TflService } from "./tfl.service"

@Module({
  imports: [FeedCacheModule],
  providers: [TflService],
  exports: [TflService],
})
export class TflModule {}
