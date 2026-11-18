
SET FOREIGN_KEY_CHECKS=0;


-- ----------------------------
-- Table structure for erp_users
-- ----------------------------
DROP TABLE IF EXISTS `erp_users`;
CREATE TABLE `erp_users` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `login` varchar(190) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` varchar(32) NOT NULL DEFAULT 'user',
  `username` varchar(190) DEFAULT NULL,
  `info` varchar(255) DEFAULT NULL,
  `trees` varchar(500) NOT NULL DEFAULT '',
  `qrkey` varchar(64) DEFAULT NULL,
  `scantype` tinyint(3) unsigned NOT NULL DEFAULT 1,
  `auth_version` int(10) unsigned NOT NULL DEFAULT 1,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_erp_users_login` (`login`)
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `erp_users` VALUES ('1', 'root', '$2y$12$MKhX4Wr4rcSBpCWkYWH.4.zIHPuVMJoKoKNzyVl3kyI3yxKeFH0yq', 'admin', 'root', 'password = r00t', 'users,kanban,chat,dayplanner', '', '3', '20', '1', '2026-11-18 21:11:47', '2026-09-02 19:40:24', '2026-11-18 21:12:11');



-- ----------------------------
-- Table structure for erp_chat_members
-- ----------------------------
DROP TABLE IF EXISTS `erp_chat_members`;
CREATE TABLE `erp_chat_members` (
  `chat_id` bigint(20) unsigned NOT NULL,
  `user_id` int(10) unsigned NOT NULL,
  `joined_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`chat_id`,`user_id`),
  KEY `idx_erp_chat_members_user` (`user_id`),
  CONSTRAINT `fk_erp_chat_members_chat` FOREIGN KEY (`chat_id`) REFERENCES `erp_chats` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_erp_chat_members_user` FOREIGN KEY (`user_id`) REFERENCES `erp_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for erp_chat_messages
-- ----------------------------
DROP TABLE IF EXISTS `erp_chat_messages`;
CREATE TABLE `erp_chat_messages` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `chat_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `user_id` int(10) unsigned NOT NULL DEFAULT 0,
  `type` enum('text','image','file','delete','trash','pending','edit','settings','reaction') NOT NULL DEFAULT 'text',
  `body` mediumtext NOT NULL,
  `client_id` varchar(128) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `edited_at` datetime DEFAULT NULL,
  `revision` int(10) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_erp_chat_message_client` (`chat_id`,`user_id`,`client_id`),
  KEY `idx_erp_chat_messages_chat_id` (`chat_id`,`id`),
  KEY `idx_erp_chat_messages_user_id` (`user_id`),
  KEY `idx_erp_chat_messages_created` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=398 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for erp_chats
-- ----------------------------
DROP TABLE IF EXISTS `erp_chats`;
CREATE TABLE `erp_chats` (
  `id` bigint(20) unsigned NOT NULL,
  `created_by` int(10) unsigned NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `tab_color` char(7) NOT NULL DEFAULT '#334155',
  PRIMARY KEY (`id`),
  KEY `idx_erp_chats_created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;




-- ----------------------------
-- Table structure for erp_dayplanner_items
-- ----------------------------
DROP TABLE IF EXISTS `erp_dayplanner_items`;
CREATE TABLE `erp_dayplanner_items` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `author` int(10) unsigned NOT NULL,
  `client_id` varchar(64) NOT NULL,
  `source_id` int(10) unsigned DEFAULT NULL,
  `task_date` date NOT NULL,
  `text` varchar(1000) NOT NULL,
  `weight` int(10) unsigned NOT NULL DEFAULT 10,
  `created` datetime NOT NULL,
  `done` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dayplanner_client` (`author`,`client_id`),
  UNIQUE KEY `uq_dayplanner_source` (`author`,`task_date`,`source_id`),
  KEY `idx_dayplanner_day_order` (`author`,`task_date`,`weight`,`id`),
  KEY `idx_dayplanner_history` (`author`,`task_date`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ----------------------------
-- Table structure for erp_kanban_boards
-- ----------------------------
DROP TABLE IF EXISTS `erp_kanban_boards`;
CREATE TABLE `erp_kanban_boards` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(190) NOT NULL,
  `description` varchar(1000) DEFAULT NULL,
  `created_by` int(10) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_kanban_boards_updated` (`updated_at`),
  KEY `idx_kanban_boards_created_by` (`created_by`),
  CONSTRAINT `fk_kanban_boards_created_by` FOREIGN KEY (`created_by`) REFERENCES `erp_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of erp_kanban_boards
-- ----------------------------
INSERT INTO `erp_kanban_boards` VALUES ('1', 'Тест', null, '1', '2026-09-02 21:53:16', '2026-09-03 01:06:40');

-- ----------------------------
-- Table structure for erp_kanban_cards
-- ----------------------------
DROP TABLE IF EXISTS `erp_kanban_cards`;
CREATE TABLE `erp_kanban_cards` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_uid` varchar(64) DEFAULT NULL,
  `board_id` int(10) unsigned NOT NULL,
  `column_id` int(10) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `due_date` date DEFAULT NULL,
  `assigned_user_id` int(10) unsigned DEFAULT NULL,
  `position` int(10) unsigned NOT NULL DEFAULT 1024,
  `created_by` int(10) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_kanban_cards_client_uid` (`client_uid`),
  KEY `idx_kanban_cards_board_column_position` (`board_id`,`column_id`,`position`,`id`),
  KEY `idx_kanban_cards_assigned_user` (`assigned_user_id`),
  KEY `idx_kanban_cards_due_date` (`due_date`),
  KEY `fk_kanban_cards_column` (`column_id`),
  KEY `fk_kanban_cards_created_by` (`created_by`),
  CONSTRAINT `fk_kanban_cards_assigned_user` FOREIGN KEY (`assigned_user_id`) REFERENCES `erp_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_kanban_cards_board` FOREIGN KEY (`board_id`) REFERENCES `erp_kanban_boards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_kanban_cards_column` FOREIGN KEY (`column_id`) REFERENCES `erp_kanban_columns` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_kanban_cards_created_by` FOREIGN KEY (`created_by`) REFERENCES `erp_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of erp_kanban_cards
-- ----------------------------
INSERT INTO `erp_kanban_cards` VALUES ('1', '099055bd-df51-4783-bbdc-d1866a1b719a', '1', '1', 'test', null, '0', null, null, '1024', '1', '2026-09-02 21:54:13', '2026-09-02 21:54:13');

-- ----------------------------
-- Table structure for erp_kanban_columns
-- ----------------------------
DROP TABLE IF EXISTS `erp_kanban_columns`;
CREATE TABLE `erp_kanban_columns` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_uid` varchar(64) DEFAULT NULL,
  `board_id` int(10) unsigned NOT NULL,
  `name` varchar(190) NOT NULL,
  `position` int(10) unsigned NOT NULL DEFAULT 1024,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_kanban_columns_client_uid` (`client_uid`),
  KEY `idx_kanban_columns_board_position` (`board_id`,`position`,`id`),
  CONSTRAINT `fk_kanban_columns_board` FOREIGN KEY (`board_id`) REFERENCES `erp_kanban_boards` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of erp_kanban_columns
-- ----------------------------
INSERT INTO `erp_kanban_columns` VALUES ('1', null, '1', 'Запланировано', '1024', '2026-09-02 21:53:16', '2026-09-03 01:06:40');
INSERT INTO `erp_kanban_columns` VALUES ('2', null, '1', 'В работе', '2048', '2026-09-02 21:53:16', '2026-09-03 01:06:40');
INSERT INTO `erp_kanban_columns` VALUES ('3', null, '1', 'Готово', '3072', '2026-09-02 21:53:16', '2026-09-02 21:53:16');
