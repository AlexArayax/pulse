<?php

declare(strict_types=1);

defined('ERP_ENTRY') || exit;

final class ErpHttpException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status = 400
    ) {
        parent::__construct($message);
    }
}

function erp_run(): never
{
    $config = erp_config();

    date_default_timezone_set(
        (string)($config['timezone'] ?? 'UTC')
    );

    erp_security_headers();

    try {
        $pdo = erp_pdo($config);
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

        if ($method === 'POST') {
            erp_handle_post($pdo, $config);
        }

        erp_handle_page($pdo, $config);
    } catch (ErpHttpException $e) {
        erp_json([
            'status' => 'error',
            'message' => $e->getMessage(),
        ], $e->status);
    } catch (Throwable $e) {
        error_log((string)$e);

        if ($method ?? '' === 'POST') {
            erp_json([
                'status' => 'error',
                'message' => !empty($config['debug'])
                    ? $e->getMessage()
                    : 'Внутренняя ошибка сервера',
            ], 500);
        }

        http_response_code(500);
        echo 'ERP initialization error';
        exit;
    }
}

function erp_config(): array
{
    static $config;

    if ($config === null) {
        $config = require ERP_ROOT . '/config.php';
    }

    return $config;
}

function erp_pdo(array $config): PDO
{
    static $pdo;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $db = $config['db'];

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'],
        (int)($db['port'] ?? 3306),
        $db['name'],
        $db['charset'] ?? 'utf8mb4'
    );

    $pdo = new PDO(
        $dsn,
        $db['user'],
        $db['pass'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]
    );

    return $pdo;
}

function erp_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: same-origin');
    header('Permissions-Policy: camera=(self), microphone=()');
    header('Cache-Control: no-store');
}

function erp_handle_post(PDO $pdo, array $config): never
{
    $input = erp_input();
    $action = (string)($input['action'] ?? '');

    if ($action === 'login') {
        $result = erp_login(
            $pdo,
            $config,
            trim((string)($input['login'] ?? '')),
            (string)($input['password'] ?? '')
        );

        erp_json($result, $result['status'] === 'ok' ? 200 : 401);
    }

    $user = erp_current_user($pdo, $config);

    if (!$user) {
        erp_json([
            'status' => 'error',
            'code' => 'not_logged',
            'message' => 'Требуется авторизация',
        ], 401);
    }

    erp_check_csrf($user);

    $module = preg_replace(
        '/[^a-zA-Z0-9_-]/',
        '',
        (string)($input['module'] ?? '')
    );

    if ($module === '') {
        throw new ErpHttpException('Не указан модуль');
    }

    if (!erp_can_use_module($user, $module, $config)) {
        throw new ErpHttpException('Нет доступа к модулю', 403);
    }

    $file = ERP_ROOT . '/api/' . $module . '.php';

    if (!is_file($file)) {
        throw new ErpHttpException('API модуля не найдено', 404);
    }

    require_once $file;

    $handler = 'erp_api_' . $module;

    if (!is_callable($handler)) {
        throw new ErpHttpException('Некорректный обработчик модуля', 500);
    }

    $result = $handler($pdo, $input, $user, $config);

    erp_json($result);
}

function erp_handle_page(PDO $pdo, array $config): never
{
    $action = (string)($_GET['action'] ?? '');

    if ($action === 'logout') {
        erp_logout($pdo, $config);

        header('Location: ' . $config['router_url']);
        exit;
    }

    $user = erp_current_user($pdo, $config);

    $availableModules = [];

    if ($user) {
        foreach ($config['modules'] as $name => $module) {
            if (
                !empty($module['enabled'])
                && erp_can_use_module($user, $name, $config)
            ) {
                $availableModules[$name] = [
                    'title' => $module['title'] ?? $name,
                    'hidden' => !empty($module['hidden']),
                ];
            }
        }
    }

    $bootstrap = [
        'authenticated' => $user !== null,
        'routerUrl' => $config['router_url'],
        'assetsUrl' => $config['assets_url'],
        'appName' => $config['app_name'],
        'version' => $config['app_version'],
        'csrf' => $user['csrf'] ?? null,
        
    'chat' => [
        'pollIntervalMs' => (int)(
            $config['chat']['poll_interval_ms'] ?? 2500
        ),
        'statusIntervalMs' => (int)(
            $config['chat']['status_interval_ms'] ?? 10000
        ),
    ],

        'user' => $user ? [
            'id' => (int)$user['id'],
            'login' => $user['login'],
            'username' => $user['username'],
            'role' => $user['role'],
        ] : null,
        'modules' => $availableModules,
    ];

    $bootstrapJson = json_encode(
        $bootstrap,
        JSON_UNESCAPED_UNICODE
        | JSON_UNESCAPED_SLASHES
        | JSON_HEX_TAG
        | JSON_HEX_AMP
        | JSON_HEX_APOS
        | JSON_HEX_QUOT
        | JSON_THROW_ON_ERROR
    );

    $assets = htmlspecialchars(
        (string)$config['assets_url'],
        ENT_QUOTES,
        'UTF-8'
    );

    $version = rawurlencode((string)$config['app_version']);

    header('Content-Type: text/html; charset=utf-8');

    echo <<<HTML
<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta
        name="viewport"
        content="width=device-width,initial-scale=1,viewport-fit=cover"
    >
    <meta name="theme-color" content="#263238">
    <title>{$config['app_name']}</title>
    <link rel="stylesheet" href="{$assets}/assets/app.css?v={$version}">
</head>
<body>
    <div id="app"></div>

    <script id="erp-bootstrap" type="application/json">{$bootstrapJson}</script>
    <script
        type="module"
        src="{$assets}/assets/app.js?v={$version}"
    ></script>
</body>
</html>
HTML;

    exit;
}

function erp_input(): array
{
    $contentType = strtolower(
        (string)($_SERVER['CONTENT_TYPE'] ?? '')
    );

    if (str_contains($contentType, 'application/json')) {
        $raw = file_get_contents('php://input');

        if ($raw === false || $raw === '') {
            return [];
        }

        $data = json_decode($raw, true);

        if (!is_array($data)) {
            throw new ErpHttpException('Некорректный JSON');
        }

        return $data;
    }

    return $_POST;
}

function erp_json(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');

    echo json_encode(
        $data,
        JSON_UNESCAPED_UNICODE
        | JSON_UNESCAPED_SLASHES
        | JSON_THROW_ON_ERROR
    );

    exit;
}

function erp_login(
    PDO $pdo,
    array $config,
    string $login,
    string $password
): array {
    if ($login === '' || $password === '') {
        usleep(300000);

        return [
            'status' => 'error',
            'message' => 'Введите логин и пароль',
        ];
    }

    $stmt = $pdo->prepare(
        'SELECT *
         FROM erp_users
         WHERE login = ?
           AND active = 1
         LIMIT 1'
    );

    $stmt->execute([$login]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        usleep(500000);

        return [
            'status' => 'error',
            'message' => 'Неверный логин или пароль',
        ];
    }

    $csrf = bin2hex(random_bytes(16));

    $payload = [
        'sub' => (int)$user['id'],
        'ver' => (int)$user['auth_version'],
        'csrf' => $csrf,
        'iat' => time(),
        'exp' => time() + (int)$config['auth']['jwt_ttl'],
    ];

    $token = erp_jwt_encode(
        $payload,
        (string)$config['auth']['jwt_secret']
    );

    $secure = $config['auth']['secure_cookie'];

    if ($secure === null) {
        $secure = erp_is_https();
    }

    setcookie(
        (string)$config['auth']['cookie_name'],
        $token,
        [
            'expires' => $payload['exp'],
            'path' => $config['auth']['cookie_path'] ?? '/',
            'secure' => (bool)$secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]
    );

    $pdo->prepare(
        'UPDATE erp_users
         SET last_login_at = NOW()
         WHERE id = ?'
    )->execute([(int)$user['id']]);

    return ['status' => 'ok'];
}

function erp_logout(PDO $pdo, array $config): void
{
    $user = erp_current_user($pdo, $config);

    if ($user) {
        /*
         * Инвалидация всех JWT пользователя.
         */
        $pdo->prepare(
            'UPDATE erp_users
             SET auth_version = auth_version + 1
             WHERE id = ?'
        )->execute([(int)$user['id']]);
    }

    setcookie(
        (string)$config['auth']['cookie_name'],
        '',
        [
            'expires' => time() - 3600,
            'path' => $config['auth']['cookie_path'] ?? '/',
            'secure' => erp_is_https(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]
    );
}

function erp_current_user(PDO $pdo, array $config): ?array
{
    static $loaded = false;
    static $current = null;

    if ($loaded) {
        return $current;
    }

    $loaded = true;

    $cookieName = (string)$config['auth']['cookie_name'];
    $token = (string)($_COOKIE[$cookieName] ?? '');

    if ($token === '') {
        return null;
    }

    $payload = erp_jwt_decode(
        $token,
        (string)$config['auth']['jwt_secret']
    );

    if (!$payload || empty($payload['sub'])) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT
            id,
            login,
            username,
            role,
            trees,
            scantype,
            qrkey,
            auth_version,
            active
         FROM erp_users
         WHERE id = ?
           AND active = 1
         LIMIT 1'
    );

    $stmt->execute([(int)$payload['sub']]);
    $user = $stmt->fetch();

    if (!$user) {
        return null;
    }

    if ((int)$user['auth_version'] !== (int)($payload['ver'] ?? -1)) {
        return null;
    }

    $user['csrf'] = (string)($payload['csrf'] ?? '');

    return $current = $user;
}

function erp_can_use_module(
    array $user,
    string $requestedModule,
    array $config
): bool {
    $modules = $config['modules'] ?? [];

    if (
        !isset($modules[$requestedModule])
        || empty($modules[$requestedModule]['enabled'])
    ) {
        return false;
    }

    if (
        !empty($modules[$requestedModule]['admin_only'])
        && ($user['role'] ?? '') !== 'admin'
    ) {
        return false;
    }

    if (($user['role'] ?? '') === 'admin' || ($user['trees'] ?? '') === '*') {
        return true;
    }

    $allowed = array_values(array_filter(array_map(
        'trim',
        explode(',', (string)($user['trees'] ?? ''))
    )));

    if (in_array($requestedModule, $allowed, true)) {
        return true;
    }

    /*
     * Разрешаем скрытый зависимый модуль, например personEditor,
     * если пользователю доступен chains.
     */
    foreach ($allowed as $moduleName) {
        $dependencies = $modules[$moduleName]['dependencies'] ?? [];

        if (in_array($requestedModule, $dependencies, true)) {
            return true;
        }
    }

    return false;
}

function erp_check_csrf(array $user): void
{
    $header = (string)(
        $_SERVER['HTTP_X_CSRF_TOKEN']
        ?? $_SERVER['HTTP_X_CSRF']
        ?? ''
    );

    $expected = (string)($user['csrf'] ?? '');

    if (
        $header === ''
        || $expected === ''
        || !hash_equals($expected, $header)
    ) {
        throw new ErpHttpException('Недействительный CSRF-токен', 403);
    }
}

function erp_jwt_encode(array $payload, string $key): string
{
    $header = [
        'typ' => 'JWT',
        'alg' => 'HS256',
    ];

    $head = erp_base64url_encode(json_encode(
        $header,
        JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    ));

    $body = erp_base64url_encode(json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    ));

    $signature = hash_hmac(
        'sha256',
        $head . '.' . $body,
        $key,
        true
    );

    return $head . '.' . $body . '.' . erp_base64url_encode($signature);
}

function erp_jwt_decode(string $token, string $key): array|false
{
    $parts = explode('.', $token);

    if (count($parts) !== 3) {
        return false;
    }

    [$head, $body, $signature] = $parts;

    $header = json_decode(erp_base64url_decode($head), true);
    $payload = json_decode(erp_base64url_decode($body), true);

    if (
        !is_array($header)
        || !is_array($payload)
        || ($header['alg'] ?? '') !== 'HS256'
    ) {
        return false;
    }

    $expected = erp_base64url_encode(hash_hmac(
        'sha256',
        $head . '.' . $body,
        $key,
        true
    ));

    if (!hash_equals($expected, $signature)) {
        return false;
    }

    $now = time();

    if (
        empty($payload['exp'])
        || (int)$payload['exp'] < $now
        || (int)($payload['iat'] ?? 0) > $now + 60
    ) {
        return false;
    }

    return $payload;
}

function erp_base64url_encode(string $value): string
{
    return rtrim(
        strtr(base64_encode($value), '+/', '-_'),
        '='
    );
}

function erp_base64url_decode(string $value): string
{
    $padding = strlen($value) % 4;

    if ($padding !== 0) {
        $value .= str_repeat('=', 4 - $padding);
    }

    $decoded = base64_decode(
        strtr($value, '-_', '+/'),
        true
    );

    return $decoded === false ? '' : $decoded;
}

function erp_is_https(): bool
{
    if (
        !empty($_SERVER['HTTPS'])
        && strtolower((string)$_SERVER['HTTPS']) !== 'off'
    ) {
        return true;
    }

    return strtolower(
        (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')
    ) === 'https';
}

function erp_transaction(PDO $pdo, callable $callback): mixed
{
    $pdo->beginTransaction();

    try {
        $result = $callback();
        $pdo->commit();

        return $result;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }

        throw $e;
    }
}