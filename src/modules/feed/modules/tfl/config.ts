import { z } from "zod"

export const TflConfigSchema = z.strictObject({
  baseUrl: z.string().default("https://api.tfl.gov.uk"),
  apiKey: z
    .string()
    .optional()
    .default(process.env.TFL_API_KEY ?? ""),
})

export type TflConfig = z.infer<typeof TflConfigSchema>
