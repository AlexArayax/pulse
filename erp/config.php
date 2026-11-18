<?php

declare(strict_types=1);

defined('ERP_ENTRY') || exit;

return [
    'router_url' => '/erp/',
    'assets_url' => '/erp',

    'app_name' => 'Pulse ERP',
    'app_version' => '2026.11.17-offline-34',
    'debug' => false,
    'timezone' => 'Europe/Moscow',

    'db' => [
        'host' => getenv('ERP_DB_HOST') ?: 'localhost',
        'port' => 3306,
        'name' => getenv('ERP_DB_NAME') ?: '',
        'user' => getenv('ERP_DB_USER') ?: '',
        'pass' => getenv('ERP_DB_PASS') ?: '',
        'charset' => 'utf8mb4',
    ],

    'auth' => [
        'jwt_secret' => getenv('ERP_JWT_SECRET')
            ?: 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET_32_CHARS',
        'jwt_ttl' => 7 * 24 * 60 * 60,
        'cookie_name' => 'erp_token',
        'cookie_path' => '/',
        'secure_cookie' => null,
    ],

    'modules' => [
        'dayplanner' => [
            'title' => 'Сегодня',
            'enabled' => true,
            'hidden' => false,
            'admin_only' => false,
            'dependencies' => [],
        ],

        'users' => [
            'title' => 'Пользователи',
            'enabled' => true,
            'hidden' => false,
            'admin_only' => true,
            'dependencies' => [],
        ],

        'kanban' => [
            'title' => 'Задачи',
            'enabled' => true,
            'hidden' => false,
            'admin_only' => false,
            'dependencies' => [],
        ],

        'chat' => [
            'title' => 'Чат',
            'enabled' => true,
            'hidden' => false,
            'admin_only' => false,
            'dependencies' => [],
        ],
    ],

    'chat' => [
        'private_upload_dir' => '/home/users/domains/sitename/chat/',
        'poll_interval_ms' => 2500,
        'status_interval_ms' => 10000,

        'upload_max_bytes' => 10 * 1024 * 1024,
        'allowed_file_extensions' => [
            'pdf',
            'txt',
            'csv',
            'doc',
            'docx',
            'xls',
            'xlsx',
            'zip',
        ],

        'ai' => [
            'enabled' => true,
            'endpoint' => 'https://openrouter.ai/api/v1/chat/completions',
            'api_key' => getenv('OPENROUTER_API_KEY') ?: 'sk-or-v1-',

            'model' => 'openai/gpt-6.1-sol',
            'extended_model' => 'openai/gpt-6.1-sol',
            'analysis_model' => 'openai/gpt-6-luna',
            'summary_model' => 'openai/gpt-6-luna',
            'summary_max_tokens' => 3500,
            'history_max_bytes' => 600000,

            'image_endpoint' => 'https://openrouter.ai/api/v1/images',
            'image_model' => 'openai/gpt-image-2.6-sunburst',
            'image_quality' => 'medium',
            'image_input_max_bytes' => 20 * 1024 * 1024,
            'image_timeout' => 240,

            'system_prompt' => 'Отвечай, кратко и по делу.',
            'temperature' => 0.6,
            'max_tokens' => 800,
            'extended_max_tokens' => 2000,
            'timeout' => 180,
            'connect_timeout' => 25,
            'referer' => 'https://your-erp.example',
            'app_title' => 'ERP Chat',

            'proxy_address' => getenv('ERP_AI_PROXY') ?: '158.x.x.x:y',
            'proxy_user' => getenv('ERP_AI_PROXY_USER') ?: '',
            'proxy_password' => getenv('ERP_AI_PROXY_PASSWORD') ?: '',
        ],
    ],
];