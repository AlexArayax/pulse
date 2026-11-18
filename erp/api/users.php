<?php

declare(strict_types=1);

defined('ERP_ENTRY') || exit;

function erp_api_users(
    PDO $pdo,
    array $input,
    array $user,
    array $config
): array {
    if (($user['role'] ?? '') !== 'admin') {
        throw new ErpHttpException('Только для администратора', 403);
    }

    return match ((string)($input['action'] ?? '')) {
        'list' => erp_users_list($pdo),
        'save' => erp_users_save($pdo, $input, $user),
        'delete' => erp_users_delete($pdo, $input, $user),
        default => throw new ErpHttpException('Неизвестное действие'),
    };
}

function erp_users_list(PDO $pdo): array
{
    return [
        'status' => 'ok',
        'items' => $pdo->query(
            'SELECT
                id,
                login,
                role,
                username,
                info,
                trees,
                qrkey,
                scantype,
                active,
                last_login_at
             FROM erp_users
             ORDER BY id'
        )->fetchAll(),
    ];
}

function erp_users_save(
    PDO $pdo,
    array $input,
    array $currentUser
): array {
    $data = $input['data'] ?? null;

    if (!is_array($data)) {
        throw new ErpHttpException('Нет данных');
    }

    $id = (int)($data['id'] ?? 0);
    $login = trim((string)($data['login'] ?? ''));
    $password = (string)($data['password'] ?? '');

    if ($login === '') {
        throw new ErpHttpException('Логин обязателен');
    }

    $role = in_array(
        $data['role'] ?? '',
        ['admin', 'user'],
        true
    ) ? $data['role'] : 'user';

    $fields = [
        'login' => $login,
        'role' => $role,
        'username' => trim((string)($data['username'] ?? '')),
        'info' => trim((string)($data['info'] ?? '')),
        'trees' => trim((string)($data['trees'] ?? '')),
        'qrkey' => trim((string)($data['qrkey'] ?? '')),
        'scantype' => max(1, min(3, (int)($data['scantype'] ?? 1))),
        'active' => !empty($data['active']) ? 1 : 0,
    ];

    if ($id <= 0 && $password === '') {
        throw new ErpHttpException(
            'Для нового пользователя требуется пароль'
        );
    }

    try {
        if ($id > 0) {
            $set = array_map(
                fn(string $field): string => "`{$field}` = ?",
                array_keys($fields)
            );

            $values = array_values($fields);

            if ($password !== '') {
                $set[] = 'password_hash = ?';
                $set[] = 'auth_version = auth_version + 1';
                $values[] = password_hash(
                    $password,
                    PASSWORD_DEFAULT
                );
            }

            $values[] = $id;

            $pdo->prepare(
                'UPDATE erp_users
                 SET ' . implode(', ', $set) . '
                 WHERE id = ?'
            )->execute($values);
        } else {
            $fields['password_hash'] = password_hash(
                $password,
                PASSWORD_DEFAULT
            );

            $keys = array_keys($fields);

            $pdo->prepare(
                'INSERT INTO erp_users (`'
                . implode('`,`', $keys)
                . '`) VALUES ('
                . implode(',', array_fill(0, count($keys), '?'))
                . ')'
            )->execute(array_values($fields));

            $id = (int)$pdo->lastInsertId();
        }
    } catch (PDOException $e) {
        if ((string)$e->getCode() === '23000') {
            throw new ErpHttpException(
                'Пользователь с таким логином уже существует'
            );
        }

        throw $e;
    }

    return [
        'status' => 'ok',
        'id' => $id,
    ];
}

function erp_users_delete(
    PDO $pdo,
    array $input,
    array $currentUser
): array {
    $id = (int)($input['id'] ?? 0);

    if ($id <= 0) {
        throw new ErpHttpException('Некорректный ID');
    }

    if ($id === (int)$currentUser['id']) {
        throw new ErpHttpException(
            'Нельзя удалить текущего пользователя'
        );
    }

    $pdo->prepare(
        'DELETE FROM erp_users WHERE id = ?'
    )->execute([$id]);

    return ['status' => 'ok'];
}