ALTER TABLE `session` ADD `session_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `session_project_key_unique_idx` ON `session` (`project_id`,`session_key`);