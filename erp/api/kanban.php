<?php

declare(strict_types=1);

defined('ERP_ENTRY') || exit;

function erp_api_kanban(
    PDO $pdo,
    array $input,
    array $user,
    array $config
): array {
    $action = (string)($input['action'] ?? '');

    return match ($action) {
        'boards' => erp_kanban_get_boards($pdo),
        'get_board' => erp_kanban_get_board(
            $pdo,
            (int)($input['board_id'] ?? 0)
        ),

        'save_board' => erp_kanban_save_board(
            $pdo,
            $input,
            $user
        ),

        'delete_board' => erp_kanban_delete_board(
            $pdo,
            (int)($input['board_id'] ?? 0)
        ),

        'save_column' => erp_kanban_save_column(
            $pdo,
            $input
        ),

        'delete_column' => erp_kanban_delete_column(
            $pdo,
            (int)($input['column_id'] ?? 0)
        ),

        'reorder_columns' => erp_kanban_reorder_columns(
            $pdo,
            $input
        ),

        'save_card' => erp_kanban_save_card(
            $pdo,
            $input,
            $user
        ),

        'delete_card' => erp_kanban_delete_card(
            $pdo,
            (int)($input['card_id'] ?? 0)
        ),

        'move_card' => erp_kanban_move_card(
            $pdo,
            $input
        ),

        default => throw new ErpHttpException(
            'Неизвестное действие Kanban'
        ),
    };
}

function erp_kanban_get_boards(PDO $pdo): array
{
    $boards = $pdo->query(
        'SELECT
            b.id,
            b.name,
            b.description,
            b.created_by,
            b.created_at,
            b.updated_at,
            COUNT(DISTINCT c.id) AS columns_count,
            COUNT(DISTINCT k.id) AS cards_count
         FROM erp_kanban_boards b
         LEFT JOIN erp_kanban_columns c
            ON c.board_id = b.id
         LEFT JOIN erp_kanban_cards k
            ON k.board_id = b.id
         GROUP BY
            b.id,
            b.name,
            b.description,
            b.created_by,
            b.created_at,
            b.updated_at
         ORDER BY b.updated_at DESC, b.id DESC'
    )->fetchAll();

    return [
        'status' => 'ok',
        'boards' => $boards,
    ];
}

function erp_kanban_get_board(
    PDO $pdo,
    int $boardId
): array {
    if ($boardId <= 0) {
        throw new ErpHttpException('Некорректная доска');
    }

    $stmt = $pdo->prepare(
        'SELECT
            id,
            name,
            description,
            created_by,
            created_at,
            updated_at
         FROM erp_kanban_boards
         WHERE id = ?
         LIMIT 1'
    );

    $stmt->execute([$boardId]);
    $board = $stmt->fetch();

    if (!$board) {
        throw new ErpHttpException('Доска не найдена', 404);
    }

    $columnsStmt = $pdo->prepare(
        'SELECT
            id,
            client_uid,
            board_id,
            name,
            position,
            created_at,
            updated_at
         FROM erp_kanban_columns
         WHERE board_id = ?
         ORDER BY position ASC, id ASC'
    );

    $columnsStmt->execute([$boardId]);

    $cardsStmt = $pdo->prepare(
        'SELECT
            c.id,
            c.client_uid,
            c.board_id,
            c.column_id,
            c.title,
            c.description,
            c.priority,
            c.due_date,
            c.assigned_user_id,
            c.position,
            c.created_by,
            c.created_at,
            c.updated_at,
            u.username AS assigned_username,
            u.login AS assigned_login
         FROM erp_kanban_cards c
         LEFT JOIN erp_users u
            ON u.id = c.assigned_user_id
         WHERE c.board_id = ?
         ORDER BY
            c.column_id ASC,
            c.position ASC,
            c.id ASC'
    );

    $cardsStmt->execute([$boardId]);

    $users = $pdo->query(
        'SELECT
            id,
            login,
            username
         FROM erp_users
         WHERE active = 1
         ORDER BY
            COALESCE(NULLIF(username, \'\'), login),
            id'
    )->fetchAll();

    return [
        'status' => 'ok',
        'board' => $board,
        'columns' => $columnsStmt->fetchAll(),
        'cards' => $cardsStmt->fetchAll(),
        'users' => $users,
        'server_time' => time(),
    ];
}

function erp_kanban_save_board(
    PDO $pdo,
    array $input,
    array $user
): array {
    $boardId = (int)($input['board_id'] ?? 0);
    $name = trim((string)($input['name'] ?? ''));
    $description = trim((string)($input['description'] ?? ''));

    if ($name === '') {
        throw new ErpHttpException('Введите название доски');
    }

    if (mb_strlen($name) > 190) {
        throw new ErpHttpException(
            'Название доски слишком длинное'
        );
    }

    if (mb_strlen($description) > 1000) {
        throw new ErpHttpException(
            'Описание доски слишком длинное'
        );
    }

    if ($boardId > 0) {
        $stmt = $pdo->prepare(
            'UPDATE erp_kanban_boards
             SET
                name = ?,
                description = ?
             WHERE id = ?'
        );

        $stmt->execute([
            $name,
            $description !== '' ? $description : null,
            $boardId,
        ]);

        if ($stmt->rowCount() === 0) {
            $exists = $pdo->prepare(
                'SELECT 1
                 FROM erp_kanban_boards
                 WHERE id = ?'
            );

            $exists->execute([$boardId]);

            if (!$exists->fetchColumn()) {
                throw new ErpHttpException(
                    'Доска не найдена',
                    404
                );
            }
        }

        return [
            'status' => 'ok',
            'id' => $boardId,
        ];
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $name,
            $description,
            $user
        ): array {
            $stmt = $pdo->prepare(
                'INSERT INTO erp_kanban_boards (
                    name,
                    description,
                    created_by
                 ) VALUES (?, ?, ?)'
            );

            $stmt->execute([
                $name,
                $description !== '' ? $description : null,
                (int)$user['id'],
            ]);

            $boardId = (int)$pdo->lastInsertId();

            $columnStmt = $pdo->prepare(
                'INSERT INTO erp_kanban_columns (
                    board_id,
                    name,
                    position
                 ) VALUES (?, ?, ?)'
            );

            $defaultColumns = [
                ['Запланировано', 1024],
                ['В работе', 2048],
                ['Готово', 3072],
            ];

            foreach ($defaultColumns as [$columnName, $position]) {
                $columnStmt->execute([
                    $boardId,
                    $columnName,
                    $position,
                ]);
            }

            return [
                'status' => 'ok',
                'id' => $boardId,
            ];
        }
    );
}

function erp_kanban_delete_board(
    PDO $pdo,
    int $boardId
): array {
    if ($boardId <= 0) {
        throw new ErpHttpException('Некорректная доска');
    }

    $stmt = $pdo->prepare(
        'DELETE FROM erp_kanban_boards
         WHERE id = ?'
    );

    $stmt->execute([$boardId]);

    if ($stmt->rowCount() !== 1) {
        throw new ErpHttpException('Доска не найдена', 404);
    }

    return ['status' => 'ok'];
}

function erp_kanban_save_column(
    PDO $pdo,
    array $input
): array {
    $columnId = (int)($input['column_id'] ?? 0);
    $boardId = (int)($input['board_id'] ?? 0);
    $name = trim((string)($input['name'] ?? ''));
    $clientUid = erp_kanban_normalize_uid(
        (string)($input['client_uid'] ?? '')
    );

    if ($name === '') {
        throw new ErpHttpException('Введите название колонки');
    }

    if (mb_strlen($name) > 190) {
        throw new ErpHttpException(
            'Название колонки слишком длинное'
        );
    }

    if ($columnId > 0) {
        $stmt = $pdo->prepare(
            'UPDATE erp_kanban_columns
             SET name = ?
             WHERE id = ?'
        );

        $stmt->execute([$name, $columnId]);

        if ($stmt->rowCount() === 0) {
            $exists = $pdo->prepare(
                'SELECT 1
                 FROM erp_kanban_columns
                 WHERE id = ?'
            );

            $exists->execute([$columnId]);

            if (!$exists->fetchColumn()) {
                throw new ErpHttpException(
                    'Колонка не найдена',
                    404
                );
            }
        }

        erp_kanban_touch_board_by_column($pdo, $columnId);

        return [
            'status' => 'ok',
            'id' => $columnId,
        ];
    }

    if ($boardId <= 0) {
        throw new ErpHttpException('Не указана доска');
    }

    if ($clientUid !== '') {
        $existing = $pdo->prepare(
            'SELECT id
             FROM erp_kanban_columns
             WHERE client_uid = ?
             LIMIT 1'
        );

        $existing->execute([$clientUid]);
        $existingId = $existing->fetchColumn();

        if ($existingId) {
            return [
                'status' => 'ok',
                'id' => (int)$existingId,
                'existing' => true,
            ];
        }
    }

    $boardExists = $pdo->prepare(
        'SELECT 1
         FROM erp_kanban_boards
         WHERE id = ?'
    );

    $boardExists->execute([$boardId]);

    if (!$boardExists->fetchColumn()) {
        throw new ErpHttpException('Доска не найдена', 404);
    }

    $positionStmt = $pdo->prepare(
        'SELECT COALESCE(MAX(position), 0) + 1024
         FROM erp_kanban_columns
         WHERE board_id = ?'
    );

    $positionStmt->execute([$boardId]);
    $position = (int)$positionStmt->fetchColumn();

    try {
        $stmt = $pdo->prepare(
            'INSERT INTO erp_kanban_columns (
                client_uid,
                board_id,
                name,
                position
             ) VALUES (?, ?, ?, ?)'
        );

        $stmt->execute([
            $clientUid !== '' ? $clientUid : null,
            $boardId,
            $name,
            max(1024, $position),
        ]);

        $columnId = (int)$pdo->lastInsertId();
    } catch (PDOException $e) {
        if (
            (string)$e->getCode() === '23000'
            && $clientUid !== ''
        ) {
            $existing = $pdo->prepare(
                'SELECT id
                 FROM erp_kanban_columns
                 WHERE client_uid = ?
                 LIMIT 1'
            );

            $existing->execute([$clientUid]);
            $columnId = (int)$existing->fetchColumn();

            if ($columnId > 0) {
                return [
                    'status' => 'ok',
                    'id' => $columnId,
                    'existing' => true,
                ];
            }
        }

        throw $e;
    }

    erp_kanban_touch_board($pdo, $boardId);

    return [
        'status' => 'ok',
        'id' => $columnId,
    ];
}

function erp_kanban_delete_column(
    PDO $pdo,
    int $columnId
): array {
    if ($columnId <= 0) {
        throw new ErpHttpException('Некорректная колонка');
    }

    $stmt = $pdo->prepare(
        'SELECT board_id
         FROM erp_kanban_columns
         WHERE id = ?'
    );

    $stmt->execute([$columnId]);
    $boardId = (int)$stmt->fetchColumn();

    if ($boardId <= 0) {
        throw new ErpHttpException('Колонка не найдена', 404);
    }

    $pdo->prepare(
        'DELETE FROM erp_kanban_columns
         WHERE id = ?'
    )->execute([$columnId]);

    erp_kanban_touch_board($pdo, $boardId);

    return ['status' => 'ok'];
}

function erp_kanban_reorder_columns(
    PDO $pdo,
    array $input
): array {
    $boardId = (int)($input['board_id'] ?? 0);
    $orderedIds = erp_kanban_normalize_ids(
        $input['column_ids'] ?? []
    );

    if ($boardId <= 0 || !$orderedIds) {
        throw new ErpHttpException(
            'Некорректный порядок колонок'
        );
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $boardId,
            $orderedIds
        ): array {
            $stmt = $pdo->prepare(
                'SELECT id
                 FROM erp_kanban_columns
                 WHERE board_id = ?
                 ORDER BY position, id
                 FOR UPDATE'
            );

            $stmt->execute([$boardId]);

            $existingIds = array_map(
                'intval',
                $stmt->fetchAll(PDO::FETCH_COLUMN)
            );

            $sortedExisting = $existingIds;
            $sortedIncoming = $orderedIds;

            sort($sortedExisting);
            sort($sortedIncoming);

            if ($sortedExisting !== $sortedIncoming) {
                throw new ErpHttpException(
                    'Набор колонок изменился. Обновите доску.'
                );
            }

            erp_kanban_set_positions(
                $pdo,
                'erp_kanban_columns',
                $orderedIds
            );

            erp_kanban_touch_board($pdo, $boardId);

            return ['status' => 'ok'];
        }
    );
}

function erp_kanban_save_card(
    PDO $pdo,
    array $input,
    array $user
): array {
    $data = $input['data'] ?? null;

    if (!is_array($data)) {
        throw new ErpHttpException('Нет данных карточки');
    }

    $cardId = (int)($data['id'] ?? 0);
    $boardId = (int)($data['board_id'] ?? 0);
    $columnId = (int)($data['column_id'] ?? 0);
    $title = trim((string)($data['title'] ?? ''));
    $description = trim((string)($data['description'] ?? ''));
    $priority = max(0, min(3, (int)($data['priority'] ?? 0)));
    $dueDate = trim((string)($data['due_date'] ?? ''));
    $assignedUserId = (int)($data['assigned_user_id'] ?? 0);
    $clientUid = erp_kanban_normalize_uid(
        (string)($data['client_uid'] ?? '')
    );

    if ($title === '') {
        throw new ErpHttpException('Введите название карточки');
    }

    if (mb_strlen($title) > 255) {
        throw new ErpHttpException(
            'Название карточки слишком длинное'
        );
    }

    if ($dueDate !== '') {
        $date = DateTimeImmutable::createFromFormat(
            '!Y-m-d',
            $dueDate
        );

        if (!$date || $date->format('Y-m-d') !== $dueDate) {
            throw new ErpHttpException('Некорректная дата');
        }
    }

    if ($assignedUserId > 0) {
        $userStmt = $pdo->prepare(
            'SELECT 1
             FROM erp_users
             WHERE id = ?
               AND active = 1'
        );

        $userStmt->execute([$assignedUserId]);

        if (!$userStmt->fetchColumn()) {
            throw new ErpHttpException(
                'Исполнитель не найден'
            );
        }
    }

    if ($cardId > 0) {
        $existingStmt = $pdo->prepare(
            'SELECT board_id
             FROM erp_kanban_cards
             WHERE id = ?'
        );

        $existingStmt->execute([$cardId]);
        $existingBoardId = (int)$existingStmt->fetchColumn();

        if ($existingBoardId <= 0) {
            throw new ErpHttpException(
                'Карточка не найдена',
                404
            );
        }

        erp_kanban_assert_column(
            $pdo,
            $existingBoardId,
            $columnId
        );

        $stmt = $pdo->prepare(
            'UPDATE erp_kanban_cards
             SET
                column_id = ?,
                title = ?,
                description = ?,
                priority = ?,
                due_date = ?,
                assigned_user_id = ?
             WHERE id = ?'
        );

        $stmt->execute([
            $columnId,
            $title,
            $description !== '' ? $description : null,
            $priority,
            $dueDate !== '' ? $dueDate : null,
            $assignedUserId > 0 ? $assignedUserId : null,
            $cardId,
        ]);

        erp_kanban_touch_board($pdo, $existingBoardId);

        return [
            'status' => 'ok',
            'id' => $cardId,
        ];
    }

    if ($boardId <= 0 || $columnId <= 0) {
        throw new ErpHttpException(
            'Не указана доска или колонка'
        );
    }

    erp_kanban_assert_column($pdo, $boardId, $columnId);

    if ($clientUid !== '') {
        $existing = $pdo->prepare(
            'SELECT id
             FROM erp_kanban_cards
             WHERE client_uid = ?
             LIMIT 1'
        );

        $existing->execute([$clientUid]);
        $existingId = $existing->fetchColumn();

        if ($existingId) {
            return [
                'status' => 'ok',
                'id' => (int)$existingId,
                'existing' => true,
            ];
        }
    }

    $positionStmt = $pdo->prepare(
        'SELECT COALESCE(MAX(position), 0) + 1024
         FROM erp_kanban_cards
         WHERE column_id = ?'
    );

    $positionStmt->execute([$columnId]);
    $position = max(1024, (int)$positionStmt->fetchColumn());

    try {
        $stmt = $pdo->prepare(
            'INSERT INTO erp_kanban_cards (
                client_uid,
                board_id,
                column_id,
                title,
                description,
                priority,
                due_date,
                assigned_user_id,
                position,
                created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        $stmt->execute([
            $clientUid !== '' ? $clientUid : null,
            $boardId,
            $columnId,
            $title,
            $description !== '' ? $description : null,
            $priority,
            $dueDate !== '' ? $dueDate : null,
            $assignedUserId > 0 ? $assignedUserId : null,
            $position,
            (int)$user['id'],
        ]);

        $cardId = (int)$pdo->lastInsertId();
    } catch (PDOException $e) {
        if (
            (string)$e->getCode() === '23000'
            && $clientUid !== ''
        ) {
            $existing = $pdo->prepare(
                'SELECT id
                 FROM erp_kanban_cards
                 WHERE client_uid = ?
                 LIMIT 1'
            );

            $existing->execute([$clientUid]);
            $cardId = (int)$existing->fetchColumn();

            if ($cardId > 0) {
                return [
                    'status' => 'ok',
                    'id' => $cardId,
                    'existing' => true,
                ];
            }
        }

        throw $e;
    }

    erp_kanban_touch_board($pdo, $boardId);

    return [
        'status' => 'ok',
        'id' => $cardId,
    ];
}

function erp_kanban_delete_card(
    PDO $pdo,
    int $cardId
): array {
    if ($cardId <= 0) {
        throw new ErpHttpException('Некорректная карточка');
    }

    $stmt = $pdo->prepare(
        'SELECT board_id
         FROM erp_kanban_cards
         WHERE id = ?'
    );

    $stmt->execute([$cardId]);
    $boardId = (int)$stmt->fetchColumn();

    if ($boardId <= 0) {
        throw new ErpHttpException('Карточка не найдена', 404);
    }

    $pdo->prepare(
        'DELETE FROM erp_kanban_cards
         WHERE id = ?'
    )->execute([$cardId]);

    erp_kanban_touch_board($pdo, $boardId);

    return ['status' => 'ok'];
}

function erp_kanban_move_card(
    PDO $pdo,
    array $input
): array {
    $cardId = (int)($input['card_id'] ?? 0);
    $targetColumnId = (int)($input['column_id'] ?? 0);
    $targetIndex = max(0, (int)($input['target_index'] ?? 0));

    if ($cardId <= 0 || $targetColumnId <= 0) {
        throw new ErpHttpException(
            'Некорректное перемещение карточки'
        );
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $cardId,
            $targetColumnId,
            $targetIndex
        ): array {
            $cardStmt = $pdo->prepare(
                'SELECT
                    id,
                    board_id,
                    column_id
                 FROM erp_kanban_cards
                 WHERE id = ?
                 FOR UPDATE'
            );

            $cardStmt->execute([$cardId]);
            $card = $cardStmt->fetch();

            if (!$card) {
                throw new ErpHttpException(
                    'Карточка не найдена',
                    404
                );
            }

            $boardId = (int)$card['board_id'];
            $sourceColumnId = (int)$card['column_id'];

            erp_kanban_assert_column(
                $pdo,
                $boardId,
                $targetColumnId
            );

            $targetStmt = $pdo->prepare(
                'SELECT id
                 FROM erp_kanban_cards
                 WHERE column_id = ?
                   AND id <> ?
                 ORDER BY position ASC, id ASC
                 FOR UPDATE'
            );

            $targetStmt->execute([
                $targetColumnId,
                $cardId,
            ]);

            $targetIds = array_map(
                'intval',
                $targetStmt->fetchAll(PDO::FETCH_COLUMN)
            );

            $targetIndex = min(
                $targetIndex,
                count($targetIds)
            );

            array_splice(
                $targetIds,
                $targetIndex,
                0,
                [$cardId]
            );

            $pdo->prepare(
                'UPDATE erp_kanban_cards
                 SET column_id = ?
                 WHERE id = ?'
            )->execute([
                $targetColumnId,
                $cardId,
            ]);

            if ($sourceColumnId !== $targetColumnId) {
                $sourceStmt = $pdo->prepare(
                    'SELECT id
                     FROM erp_kanban_cards
                     WHERE column_id = ?
                     ORDER BY position ASC, id ASC
                     FOR UPDATE'
                );

                $sourceStmt->execute([$sourceColumnId]);

                $sourceIds = array_map(
                    'intval',
                    $sourceStmt->fetchAll(PDO::FETCH_COLUMN)
                );

                erp_kanban_set_positions(
                    $pdo,
                    'erp_kanban_cards',
                    $sourceIds
                );
            }

            erp_kanban_set_positions(
                $pdo,
                'erp_kanban_cards',
                $targetIds
            );

            erp_kanban_touch_board($pdo, $boardId);

            return ['status' => 'ok'];
        }
    );
}

function erp_kanban_assert_column(
    PDO $pdo,
    int $boardId,
    int $columnId
): void {
    $stmt = $pdo->prepare(
        'SELECT 1
         FROM erp_kanban_columns
         WHERE id = ?
           AND board_id = ?
         LIMIT 1'
    );

    $stmt->execute([
        $columnId,
        $boardId,
    ]);

    if (!$stmt->fetchColumn()) {
        throw new ErpHttpException(
            'Колонка не принадлежит выбранной доске'
        );
    }
}

function erp_kanban_set_positions(
    PDO $pdo,
    string $table,
    array $ids
): void {
    if (!in_array(
        $table,
        ['erp_kanban_columns', 'erp_kanban_cards'],
        true
    )) {
        throw new LogicException('Unsupported Kanban table');
    }

    $stmt = $pdo->prepare(
        "UPDATE `{$table}`
         SET position = ?
         WHERE id = ?"
    );

    foreach (array_values($ids) as $index => $id) {
        $stmt->execute([
            ($index + 1) * 1024,
            (int)$id,
        ]);
    }
}

function erp_kanban_normalize_ids(mixed $ids): array
{
    if (!is_array($ids)) {
        return [];
    }

    $ids = array_map('intval', $ids);
    $ids = array_filter(
        $ids,
        fn(int $id): bool => $id > 0
    );

    return array_values(array_unique($ids));
}

function erp_kanban_normalize_uid(string $value): string
{
    return substr(
        preg_replace(
            '/[^a-zA-Z0-9_-]/',
            '',
            $value
        ) ?? '',
        0,
        64
    );
}

function erp_kanban_touch_board(
    PDO $pdo,
    int $boardId
): void {
    $stmt = $pdo->prepare(
        'UPDATE erp_kanban_boards
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = ?'
    );

    $stmt->execute([$boardId]);
}

function erp_kanban_touch_board_by_column(
    PDO $pdo,
    int $columnId
): void {
    $stmt = $pdo->prepare(
        'UPDATE erp_kanban_boards b
         INNER JOIN erp_kanban_columns c
            ON c.board_id = b.id
         SET b.updated_at = CURRENT_TIMESTAMP
         WHERE c.id = ?'
    );

    $stmt->execute([$columnId]);
}