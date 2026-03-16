import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"

const processIdSchema = Schema.String.pipe(Schema.brand("ProcessID"))

export type ProcessID = typeof processIdSchema.Type

export const ProcessID = processIdSchema.pipe(
  withStatics((schema: typeof processIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    ascending: (id?: string) => schema.makeUnsafe(Identifier.ascending("process", id)),
    zod: Identifier.schema("process").pipe(z.custom<ProcessID>()),
  })),
)
