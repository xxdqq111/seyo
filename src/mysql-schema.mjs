/**
 * MySQL 表结构
 * ==========================================================================
 * 主库（默认 seyo）只放账号和登录会话；
 * 每个账号一个独立数据库（seyo_u_<id>），里面是这位老人自己的全部数据。
 *
 * 表结构跟原来 SQLite 版一一对应，只是把 TEXT 换成 LONGTEXT、
 * 主键换成 VARCHAR(64)，并把 SQLite 的 CREATE INDEX 并进建表语句
 * （MySQL 8 不支持 CREATE INDEX IF NOT EXISTS）。
 */

export const MASTER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    username    VARCHAR(64)  NOT NULL UNIQUE,
    pass_hash   VARCHAR(255) NOT NULL,
    salt        VARCHAR(64)  NOT NULL,
    created_at  BIGINT       NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token       CHAR(64)     NOT NULL PRIMARY KEY,
    user_id     VARCHAR(64)  NOT NULL,
    account_db  VARCHAR(64)  NOT NULL,
    expires     BIGINT       NOT NULL,
    created_at  BIGINT       NOT NULL,
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_exp (expires)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];

export const ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS utterances (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    session     VARCHAR(128) NOT NULL,
    role        VARCHAR(16) NOT NULL,
    text        LONGTEXT NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    INDEX idx_utt_time (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS sentences (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    seq         BIGINT,
    statement   LONGTEXT NOT NULL,
    asks        LONGTEXT NOT NULL,
    keywords    LONGTEXT NOT NULL,
    persons     LONGTEXT NOT NULL,
    places      LONGTEXT NOT NULL,
    events      LONGTEXT NOT NULL,
    time_raw    LONGTEXT NOT NULL,
    time_label  LONGTEXT NOT NULL,
    year        INT NULL,
    confidence  DOUBLE NOT NULL DEFAULT 0.6,
    status      VARCHAR(16) NOT NULL DEFAULT 'pending',
    source      LONGTEXT NOT NULL,
    session     VARCHAR(128) NOT NULL DEFAULT '',
    asked_count INT NOT NULL DEFAULT 0,
    told_count  INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL,
    updated_at  VARCHAR(40) NOT NULL,
    polished    LONGTEXT,
    life_event  LONGTEXT,
    INDEX idx_sent_seq (seq),
    INDEX idx_sent_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS candidates (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    sentence_id VARCHAR(64),
    question    LONGTEXT NOT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at  VARCHAR(40) NOT NULL,
    resolved_at VARCHAR(40)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS topics (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    last_said   LONGTEXT NOT NULL,
    ask_count   INT NOT NULL DEFAULT 0,
    avoid_count INT NOT NULL DEFAULT 0,
    status      VARCHAR(16) NOT NULL DEFAULT 'open',
    updated_at  VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS meta (
    k VARCHAR(128) NOT NULL PRIMARY KEY,
    v LONGTEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS people (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    alias_key   VARCHAR(255) NOT NULL,
    aliases     LONGTEXT NOT NULL,
    relation    VARCHAR(64) NOT NULL DEFAULT '',
    count       INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL,
    last_seen   VARCHAR(40) NOT NULL,
    UNIQUE KEY idx_people_key (alias_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS times (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    \`key\`     VARCHAR(255) NOT NULL,
    raw         LONGTEXT NOT NULL,
    label       LONGTEXT NOT NULL,
    kind        VARCHAR(16) NOT NULL DEFAULT 'other',
    year        INT NULL,
    from_year   INT NULL,
    to_year     INT NULL,
    circa       INT NOT NULL DEFAULT 0,
    basis       LONGTEXT NOT NULL,
    count       INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL,
    last_seen   VARCHAR(40) NOT NULL,
    note        LONGTEXT,
    UNIQUE KEY idx_times_key (\`key\`),
    INDEX idx_times_year (year)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS places (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    label       VARCHAR(255) NOT NULL DEFAULT '',
    kind        VARCHAR(64) NOT NULL DEFAULT '',
    count       INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL,
    last_seen   VARCHAR(40) NOT NULL,
    year        INT NULL,
    year_from   INT NULL,
    year_to     INT NULL,
    UNIQUE KEY idx_places_label (label),
    INDEX idx_places_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS events (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    raw         LONGTEXT NOT NULL,
    count       INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL,
    last_seen   VARCHAR(40) NOT NULL,
    note        LONGTEXT,
    UNIQUE KEY idx_events_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS person_links (
    sentence_id VARCHAR(64) NOT NULL,
    person_id   VARCHAR(64) NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (sentence_id, person_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS time_links (
    sentence_id VARCHAR(64) NOT NULL,
    time_id     VARCHAR(64) NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (sentence_id, time_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS place_links (
    sentence_id VARCHAR(64) NOT NULL,
    place_id    VARCHAR(64) NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (sentence_id, place_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS event_links (
    sentence_id VARCHAR(64) NOT NULL,
    event_id    VARCHAR(64) NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    PRIMARY KEY (sentence_id, event_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS place_geo (
    name  VARCHAR(255) NOT NULL PRIMARY KEY,
    city  VARCHAR(120) NOT NULL DEFAULT '',
    geo   TINYINT NULL,
    why   LONGTEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS timeline_notes (
    k          VARCHAR(512) NOT NULL PRIMARY KEY,
    text       LONGTEXT NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS photos (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    sentence_id VARCHAR(64),
    file        VARCHAR(255) NOT NULL,
    mime        VARCHAR(64) NOT NULL DEFAULT '',
    caption     LONGTEXT NOT NULL,
    created_at  VARCHAR(40) NOT NULL,
    INDEX idx_photos_sentence (sentence_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS meds (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    dose        VARCHAR(120) NOT NULL DEFAULT '',
    times       LONGTEXT NOT NULL,
    note        VARCHAR(255) NOT NULL DEFAULT '',
    enabled     INT NOT NULL DEFAULT 1,
    created_at  VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS med_logs (
    med_id VARCHAR(64) NOT NULL,
    slot   VARCHAR(64) NOT NULL,
    at     VARCHAR(40) NOT NULL,
    PRIMARY KEY (med_id, slot)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS reminders (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    text        VARCHAR(500) NOT NULL,
    due_at      BIGINT NOT NULL,
    created_at  BIGINT NOT NULL,
    session     VARCHAR(128) NOT NULL DEFAULT 'default',
    done_at     BIGINT NULL,
    INDEX idx_reminders_due (done_at, due_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  /* 家人 ↔ 老人 的消息。sender: family / elder
     kind: text（普通消息）/ like（给当天总结点赞）/ summary_reply（回复当天总结） */
  `CREATE TABLE IF NOT EXISTS family_messages (
    id           VARCHAR(64) NOT NULL PRIMARY KEY,
    sender       VARCHAR(16) NOT NULL,
    kind         VARCHAR(16) NOT NULL DEFAULT 'text',
    text         LONGTEXT NOT NULL,
    created_at   VARCHAR(40) NOT NULL,
    delivered_at VARCHAR(40) NULL,
    read_at      VARCHAR(40) NULL,
    INDEX idx_fm_sender (sender, created_at),
    INDEX idx_fm_delivered (delivered_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  /* 每天给家人看的一段对话总结；点赞和回复直接挂在这一行 */
  `CREATE TABLE IF NOT EXISTS daily_summaries (
    day          VARCHAR(10) NOT NULL PRIMARY KEY,
    text         LONGTEXT NOT NULL,
    generated_at VARCHAR(40) NOT NULL,
    likes        INT NOT NULL DEFAULT 0,
    liked        INT NOT NULL DEFAULT 0,
    reply        LONGTEXT NULL,
    reply_at     VARCHAR(40) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  /* 老人主动求助 / 声音异常警报。家人端轮询 pending 的。 */
  `CREATE TABLE IF NOT EXISTS alerts (
    id              VARCHAR(64) NOT NULL PRIMARY KEY,
    source          VARCHAR(32) NOT NULL DEFAULT 'self',
    reason          VARCHAR(500) NOT NULL DEFAULT '',
    detail          LONGTEXT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at      VARCHAR(40) NOT NULL,
    acknowledged_at VARCHAR(40) NULL,
    INDEX idx_alerts_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];
