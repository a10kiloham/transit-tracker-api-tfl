import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common"
import { Observable, tap } from "rxjs"

const RESPONSE_SNIPPET_MAX_LENGTH = 200

function truncate(value: unknown): string {
  const str =
    typeof value === "string" ? value : JSON.stringify(value) ?? "undefined"

  if (str.length <= RESPONSE_SNIPPET_MAX_LENGTH) {
    return str
  }

  return str.slice(0, RESPONSE_SNIPPET_MAX_LENGTH) + "…"
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP")

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== "http") {
      return next.handle()
    }

    const req = context.switchToHttp().getRequest()
    const { method, originalUrl } = req
    const start = Date.now()

    this.logger.log(`→ ${method} ${originalUrl}`)

    return next.handle().pipe(
      tap({
        next: (body) => {
          const res = context.switchToHttp().getResponse()
          const duration = Date.now() - start
          this.logger.log(
            `← ${method} ${originalUrl} ${res.statusCode} ${duration}ms | ${truncate(body)}`,
          )
        },
        error: (err) => {
          const duration = Date.now() - start
          const status = err.status ?? err.statusCode ?? 500
          this.logger.warn(
            `← ${method} ${originalUrl} ${status} ${duration}ms | ${err.message}`,
          )
        },
      }),
    )
  }
}
