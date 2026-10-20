-- 岁语 MySQL 初始化（MySQL 8 / MariaDB）
-- 用法：
--   mysql -u root -p < scripts/setup-mysql.sql
-- 先修改下面的密码，再把 config/mysql.example.json 复制成 data/mysql.json
-- 并填入同一个密码。

CREATE DATABASE IF NOT EXISTS seyo
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'seyo'@'localhost' IDENTIFIED BY 'change_me';
GRANT ALL PRIVILEGES ON seyo.* TO 'seyo'@'localhost';
GRANT ALL PRIVILEGES ON `seyo_u_%`.* TO 'seyo'@'localhost';
GRANT CREATE ON *.* TO 'seyo'@'localhost';
FLUSH PRIVILEGES;
