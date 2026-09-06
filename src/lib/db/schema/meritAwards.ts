import { createInsertSchema } from "drizzle-zod";
import {
  index,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
export const meritAwardsTable = pgTable(
  "merit_awards",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    memberId: text("member_id").notNull(),
    memberTag: text("member_tag").notNull(),
    amount: numeric("amount", { precision: 4, scale: 1, mode: "number" }).notNull(),
    proofUrl: text("proof_url").notNull(),
    awardedById: text("awarded_by_id").notNull(),
    awardedByTag: text("awarded_by_tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("merit_awards_guild_member_idx").on(table.guildId, table.memberId),
    index("merit_awards_guild_created_idx").on(
      table.guildId,
      table.createdAt,
    ),
  ],
);
export const insertMeritAwardSchema = createInsertSchema(meritAwardsTable).omit(
  {
    id: true,
    createdAt: true,
  },
);
export type InsertMeritAward = z.infer<typeof insertMeritAwardSchema>;
export type MeritAward = typeof meritAwardsTable.$inferSelect;