-- ============================================================
-- SecurePrint - Academic Print Monitoring System
-- MySQL Schema for XAMPP / phpMyAdmin
-- Run this in phpMyAdmin's SQL tab or import as .sql file
-- ============================================================

CREATE DATABASE IF NOT EXISTS `monitor_print`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `monitor_print`;

-- ============================================================
-- TABLE: users
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id`                     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name`                   VARCHAR(100) NOT NULL,
  `username`               VARCHAR(50) UNIQUE DEFAULT NULL,
  `email`                  VARCHAR(150) NOT NULL UNIQUE,
  `password`               VARCHAR(255) NOT NULL COMMENT 'bcrypt hashed',
  `role`                   ENUM('faculty','admin','superadmin') NOT NULL DEFAULT 'faculty',
  `department`             VARCHAR(100) DEFAULT NULL,
  `employee_id`            VARCHAR(50) UNIQUE DEFAULT NULL,
  `is_active`                     TINYINT(1) NOT NULL DEFAULT 1,
  `status`                        ENUM('active','inactive','pending') NOT NULL DEFAULT 'active',
  `email_verified`                TINYINT(1) NOT NULL DEFAULT 0,
  `force_password_change`         TINYINT(1) NOT NULL DEFAULT 0,
  `last_login`                    DATETIME DEFAULT NULL,
  `secret_code_hash`              VARCHAR(255) DEFAULT NULL COMMENT 'bcrypt hashed secret access code',
  `reset_password_token_hash`     VARCHAR(255) UNIQUE DEFAULT NULL,
  `reset_password_expires`        DATETIME DEFAULT NULL,
  `reset_secret_otp_hash`         VARCHAR(255) UNIQUE DEFAULT NULL,
  `reset_secret_otp_expires`      DATETIME DEFAULT NULL,
  `failed_login_attempts`         INT NOT NULL DEFAULT 0,
  `locked_until`                  DATETIME DEFAULT NULL,
  `created_by`                    INT DEFAULT NULL,
  `created_at`                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_email` (`email`),
  INDEX `idx_username` (`username`),
  INDEX `idx_role`  (`role`),
  INDEX `idx_active` (`is_active`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_by` (`created_by`),
  INDEX `idx_locked_until` (`locked_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `users` ADD CONSTRAINT `fk_users_created_by` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;

-- ============================================================
-- TABLE: print_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS `print_logs` (
  `id`            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`       INT NOT NULL,
  `file_name`     VARCHAR(255) NOT NULL,
  `file_path`     TEXT DEFAULT NULL,
  `num_pages`     INT NOT NULL DEFAULT 1,
  `copies`        INT NOT NULL DEFAULT 1,
  `total_sheets`  INT NOT NULL DEFAULT 1 COMMENT 'num_pages * copies',
  `page_range`    VARCHAR(100) DEFAULT 'All',
  `printer_name`  VARCHAR(200) DEFAULT 'Default',
  `client_job_id` CHAR(36) DEFAULT NULL UNIQUE COMMENT 'Idempotency key for client print-log delivery',
  `status`        ENUM('success','failed','cancelled') NOT NULL DEFAULT 'success',
  `print_month`   TINYINT NOT NULL COMMENT '1-12',
  `print_year`    SMALLINT NOT NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_print_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id`      (`user_id`),
  INDEX `idx_month_year`   (`print_month`, `print_year`),
  INDEX `idx_created_at`   (`created_at`),
  INDEX `idx_status`       (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: reports
-- ============================================================
CREATE TABLE IF NOT EXISTS `reports` (
  `id`            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `report_name`   VARCHAR(255) NOT NULL,
  `report_type`   VARCHAR(50) NOT NULL DEFAULT 'excel',
  `generated_by`  INT DEFAULT NULL,
  `report_data`   LONGBLOB,
  `report_size`   INT DEFAULT 0,
  `month`         INT DEFAULT NULL,
  `year`          INT DEFAULT NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_report_user` FOREIGN KEY (`generated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_generated_by` (`generated_by`),
  INDEX `idx_report_month_year` (`month`, `year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`      INT DEFAULT NULL,
  `username`     VARCHAR(100) DEFAULT NULL,
  `role`         VARCHAR(50) DEFAULT NULL,
  `action`       VARCHAR(100) NOT NULL,
  `ip_address`   VARCHAR(45) DEFAULT NULL,
  `user_agent`   VARCHAR(255) DEFAULT NULL,
  `device_info`  VARCHAR(255) DEFAULT NULL,
  `metadata`     TEXT DEFAULT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_audit_user` (`user_id`),
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Useful Queries for phpMyAdmin
-- ============================================================

-- View all faculty usage this month:
SELECT 
    u.name, 
    u.department, 
    u.employee_id,
    SUM(pl.total_sheets) AS sheets_used
FROM users u
LEFT JOIN print_logs pl 
    ON u.id = pl.user_id
    AND pl.print_month = MONTH(NOW()) 
    AND pl.print_year = YEAR(NOW()) 
    AND pl.status = 'success'
WHERE u.role = 'faculty'
GROUP BY u.id 
ORDER BY sheets_used DESC;

-- Daily usage for current month:
SELECT 
    DATE(created_at) AS print_date, 
    COUNT(*) AS jobs, 
    SUM(total_sheets) AS sheets
FROM print_logs
WHERE print_month = MONTH(NOW()) 
  AND print_year = YEAR(NOW())
GROUP BY DATE(created_at) 
ORDER BY print_date DESC;
