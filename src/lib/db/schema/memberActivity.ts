import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

export const memberActivityTable = pgTable(
  "member_activity",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    userTag: text("user_tag").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("member_activity_guild_user_uniq").on(table.guildId, table.userId),
  ],
);

export type MemberActivity = typeof memberActivityTable.$inferSelect;
