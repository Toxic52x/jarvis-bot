import { createInsertSchema } from "drizzle-zod";
import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const remindersTable = pgTable(
  "reminders",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    message: text("message").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("reminders_due_at_idx").on(table.dueAt),
    index("reminders_user_id_idx").on(table.userId),
  ],
);

export const insertReminderSchema = createInsertSchema(remindersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertReminder = z.infer<typeof insertReminderSchema>;
export type Reminder = typeof remindersTable.$inferSelect;
