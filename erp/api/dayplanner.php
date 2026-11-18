<?php

declare(strict_types=1);

defined('ERP_ENTRY') || exit;

function erp_api_dayplanner(
    PDO $pdo,
    array $input,
    array $user,
    array $config
): array {
    try {
        return match ((string)($input['action'] ?? '')) {
            'init' => erp_dayplanner_init($pdo, $user),
            'list' => erp_dayplanner_list($pdo, $input, $user),
            'save' => erp_dayplanner_save($pdo, $input, $user),
            'setDone' => erp_dayplanner_set_done($pdo, $input, $user),
            'reorder' => erp_dayplanner_reorder($pdo, $input, $user),
            default => throw new ErpHttpException(
                'Неизвестное действие',
                400
            ),
        };
    } catch (PDOException $exception) {
        error_log(
            'dayplanner database error: '
            . $exception->getMessage()
        );

        throw new ErpHttpException(
            'Не удалось выполнить операцию. Попробуйте ещё раз',
            500
        );
    }
}

function erp_dayplanner_init(
    PDO $pdo,
    array $user
): array {
    $userId = (int)$user['id'];

    if ($userId <= 0) {
        throw new ErpHttpException(
            'Пользователь не определён',
            403
        );
    }

    return erp_transaction(
        $pdo,
        function () use ($pdo, $userId): array {
            $todayStmt = $pdo->query(
                'SELECT
                    CURDATE() AS today,
                    DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS yesterday'
            );

            $calendar = $todayStmt->fetch(PDO::FETCH_ASSOC);

            if (!is_array($calendar)) {
                throw new ErpHttpException(
                    'Не удалось определить текущую дату',
                    500
                );
            }

            $today = (string)$calendar['today'];
            $yesterday = (string)$calendar['yesterday'];

            $todayLock = $pdo->prepare(
                'SELECT id, source_id, weight
                 FROM erp_dayplanner_items
                 WHERE author = ?
                   AND task_date = ?
                 ORDER BY weight ASC, id ASC
                 FOR UPDATE'
            );

            $todayLock->execute([
                $userId,
                $today,
            ]);

            $todayRows = $todayLock->fetchAll(PDO::FETCH_ASSOC);

            $existingSources = [];
            $maxWeight = 0;

            foreach ($todayRows as $row) {
                $maxWeight = max(
                    $maxWeight,
                    (int)$row['weight']
                );

                if ($row['source_id'] !== null) {
                    $existingSources[(int)$row['source_id']] = true;
                }
            }

            $yesterdayStmt = $pdo->prepare(
                'SELECT id, text
                 FROM erp_dayplanner_items
                 WHERE author = ?
                   AND task_date = ?
                   AND done IS NULL
                 ORDER BY weight ASC, id ASC
                 FOR UPDATE'
            );

            $yesterdayStmt->execute([
                $userId,
                $yesterday,
            ]);

            $yesterdayRows = $yesterdayStmt->fetchAll(
                PDO::FETCH_ASSOC
            );

            $insertStmt = $pdo->prepare(
                'INSERT INTO erp_dayplanner_items (
                    author,
                    client_id,
                    source_id,
                    task_date,
                    text,
                    weight,
                    created,
                    done
                 ) VALUES (
                    :author,
                    :client_id,
                    :source_id,
                    :task_date,
                    :text,
                    :weight,
                    NOW(),
                    NULL
                 )'
            );

            $carried = 0;

            foreach ($yesterdayRows as $row) {
                $sourceId = (int)$row['id'];

                if (isset($existingSources[$sourceId])) {
                    continue;
                }

                $maxWeight += 10;

                try {
                    $insertStmt->execute([
                        ':author' => $userId,
                        ':client_id' => sprintf(
                            'carry:%d:%s',
                            $sourceId,
                            $today
                        ),
                        ':source_id' => $sourceId,
                        ':task_date' => $today,
                        ':text' => (string)$row['text'],
                        ':weight' => $maxWeight,
                    ]);

                    $existingSources[$sourceId] = true;
                    $carried++;
                } catch (PDOException $exception) {
                    if (
                        (string)$exception->getCode() === '23000'
                    ) {
                        continue;
                    }

                    throw $exception;
                }
            }

            return [
                'status' => 'ok',
                'today' => $today,
                'dates' => erp_dayplanner_fetch_dates(
                    $pdo,
                    $userId,
                    $today
                ),
                'carried' => $carried,
            ];
        }
    );
}

function erp_dayplanner_list(
    PDO $pdo,
    array $input,
    array $user
): array {
    $userId = (int)$user['id'];
    $date = erp_dayplanner_validate_date(
        $pdo,
        (string)($input['date'] ?? '')
    );

    return [
        'status' => 'ok',
        'date' => $date,
        'items' => erp_dayplanner_fetch_items(
            $pdo,
            $userId,
            $date
        ),
    ];
}

function erp_dayplanner_save(
    PDO $pdo,
    array $input,
    array $user
): array {
    $userId = (int)$user['id'];
    $date = erp_dayplanner_validate_date(
        $pdo,
        (string)($input['date'] ?? '')
    );

    $rawItems = $input['items'] ?? null;

    if (!is_array($rawItems)) {
        throw new ErpHttpException(
            'Некорректный список задач',
            422
        );
    }

    if (count($rawItems) > 100) {
        throw new ErpHttpException(
            'На один день можно сохранить не более 100 задач',
            422
        );
    }

    $items = [];
    $seenIds = [];
    $seenClientIds = [];

    foreach ($rawItems as $position => $rawItem) {
        if (!is_array($rawItem)) {
            throw new ErpHttpException(
                'Некорректная строка списка',
                422
            );
        }

        $id = max(0, (int)($rawItem['id'] ?? 0));
        $text = trim((string)($rawItem['text'] ?? ''));
        $done = ((int)($rawItem['done'] ?? 0) === 1) ? 1 : 0;
        $clientId = trim(
            (string)($rawItem['clientId'] ?? '')
        );

        if ($text === '') {
            continue;
        }

        if (erp_dayplanner_string_length($text) > 1000) {
            throw new ErpHttpException(
                'Одна задача не может быть длиннее 1000 символов',
                422
            );
        }

        if (strlen($text) > 4000) {
            throw new ErpHttpException(
                'Текст задачи слишком длинный',
                422
            );
        }

        if ($id > 0) {
            if (isset($seenIds[$id])) {
                throw new ErpHttpException(
                    'Одна задача передана несколько раз',
                    422
                );
            }

            $seenIds[$id] = true;
        } else {
            if (
                preg_match(
                    '/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i',
                    $clientId
                ) !== 1
            ) {
                throw new ErpHttpException(
                    'Не удалось идентифицировать новую задачу',
                    422
                );
            }

            if (isset($seenClientIds[$clientId])) {
                throw new ErpHttpException(
                    'Одна новая задача передана несколько раз',
                    422
                );
            }

            $seenClientIds[$clientId] = true;
        }

        $items[] = [
            'id' => $id,
            'client_id' => $clientId,
            'text' => $text,
            'done' => $done,
            'weight' => ((int)$position + 1) * 10,
        ];
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $userId,
            $date,
            $items
        ): array {
            $lockStmt = $pdo->prepare(
                'SELECT
                    id,
                    client_id,
                    done
                 FROM erp_dayplanner_items
                 WHERE author = ?
                   AND task_date = ?
                 ORDER BY weight ASC, id ASC
                 FOR UPDATE'
            );

            $lockStmt->execute([
                $userId,
                $date,
            ]);

            $existingRows = $lockStmt->fetchAll(
                PDO::FETCH_ASSOC
            );

            $existingById = [];
            $existingByClientId = [];

            foreach ($existingRows as $row) {
                $rowId = (int)$row['id'];
                $existingById[$rowId] = $row;
                $existingByClientId[(string)$row['client_id']] = $row;
            }

            $updateStmt = $pdo->prepare(
                'UPDATE erp_dayplanner_items
                 SET text = :text,
                     weight = :weight,
                     done = CASE
                         WHEN :done_value = 1
                         THEN COALESCE(done, NOW())
                         ELSE NULL
                     END
                 WHERE id = :id
                   AND author = :author
                   AND task_date = :task_date'
            );

            $insertStmt = $pdo->prepare(
                'INSERT INTO erp_dayplanner_items (
                    author,
                    client_id,
                    source_id,
                    task_date,
                    text,
                    weight,
                    created,
                    done
                 ) VALUES (
                    :author,
                    :client_id,
                    NULL,
                    :task_date,
                    :text,
                    :weight,
                    NOW(),
                    CASE
                        WHEN :done_value = 1
                        THEN NOW()
                        ELSE NULL
                    END
                 )'
            );

            $keptIds = [];

            foreach ($items as $item) {
                $itemId = (int)$item['id'];

                if ($itemId > 0) {
                    if (!isset($existingById[$itemId])) {
                        throw new ErpHttpException(
                            'Список был изменён в другой вкладке. Обновите его',
                            409
                        );
                    }

                    $updateStmt->execute([
                        ':text' => $item['text'],
                        ':weight' => $item['weight'],
                        ':done_value' => $item['done'],
                        ':id' => $itemId,
                        ':author' => $userId,
                        ':task_date' => $date,
                    ]);

                    $keptIds[$itemId] = true;
                    continue;
                }

                $clientId = (string)$item['client_id'];

                if (isset($existingByClientId[$clientId])) {
                    $existingId = (int)$existingByClientId[
                        $clientId
                    ]['id'];

                    $updateStmt->execute([
                        ':text' => $item['text'],
                        ':weight' => $item['weight'],
                        ':done_value' => $item['done'],
                        ':id' => $existingId,
                        ':author' => $userId,
                        ':task_date' => $date,
                    ]);

                    $keptIds[$existingId] = true;
                    continue;
                }

                try {
                    $insertStmt->execute([
                        ':author' => $userId,
                        ':client_id' => $clientId,
                        ':task_date' => $date,
                        ':text' => $item['text'],
                        ':weight' => $item['weight'],
                        ':done_value' => $item['done'],
                    ]);

                    $newId = (int)$pdo->lastInsertId();
                    $keptIds[$newId] = true;
                } catch (PDOException $exception) {
                    if (
                        (string)$exception->getCode() !== '23000'
                    ) {
                        throw $exception;
                    }

                    $duplicateStmt = $pdo->prepare(
                        'SELECT id, task_date
                         FROM erp_dayplanner_items
                         WHERE author = ?
                           AND client_id = ?
                         LIMIT 1
                         FOR UPDATE'
                    );

                    $duplicateStmt->execute([
                        $userId,
                        $clientId,
                    ]);

                    $duplicate = $duplicateStmt->fetch(
                        PDO::FETCH_ASSOC
                    );

                    if (
                        !is_array($duplicate)
                        || (string)$duplicate['task_date'] !== $date
                    ) {
                        throw new ErpHttpException(
                            'Конфликт идентификатора задачи',
                            409
                        );
                    }

                    $duplicateId = (int)$duplicate['id'];

                    $updateStmt->execute([
                        ':text' => $item['text'],
                        ':weight' => $item['weight'],
                        ':done_value' => $item['done'],
                        ':id' => $duplicateId,
                        ':author' => $userId,
                        ':task_date' => $date,
                    ]);

                    $keptIds[$duplicateId] = true;
                }
            }

            if ($keptIds === []) {
                $deleteStmt = $pdo->prepare(
                    'DELETE FROM erp_dayplanner_items
                     WHERE author = ?
                       AND task_date = ?'
                );

                $deleteStmt->execute([
                    $userId,
                    $date,
                ]);
            } else {
                $ids = array_keys($keptIds);
                $placeholders = implode(
                    ',',
                    array_fill(0, count($ids), '?')
                );

                $deleteStmt = $pdo->prepare(
                    'DELETE FROM erp_dayplanner_items
                     WHERE author = ?
                       AND task_date = ?
                       AND id NOT IN (' . $placeholders . ')'
                );

                $deleteStmt->execute(
                    array_merge(
                        [
                            $userId,
                            $date,
                        ],
                        $ids
                    )
                );
            }

            return [
                'status' => 'ok',
                'date' => $date,
                'items' => erp_dayplanner_fetch_items(
                    $pdo,
                    $userId,
                    $date
                ),
                'dates' => erp_dayplanner_fetch_dates(
                    $pdo,
                    $userId,
                    erp_dayplanner_current_date($pdo)
                ),
            ];
        }
    );
}

function erp_dayplanner_set_done(
    PDO $pdo,
    array $input,
    array $user
): array {
    $userId = (int)$user['id'];
    $itemId = (int)($input['id'] ?? 0);
    $done = ((int)($input['done'] ?? 0) === 1) ? 1 : 0;

    if ($itemId <= 0) {
        throw new ErpHttpException(
            'Некорректная задача',
            400
        );
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $userId,
            $itemId,
            $done
        ): array {
            $itemStmt = $pdo->prepare(
                'SELECT id
                 FROM erp_dayplanner_items
                 WHERE id = ?
                   AND author = ?
                 LIMIT 1
                 FOR UPDATE'
            );

            $itemStmt->execute([
                $itemId,
                $userId,
            ]);

            if (!$itemStmt->fetch(PDO::FETCH_ASSOC)) {
                throw new ErpHttpException(
                    'Задача не найдена',
                    404
                );
            }

            $updateStmt = $pdo->prepare(
                'UPDATE erp_dayplanner_items
                 SET done = CASE
                     WHEN :done_value = 1
                     THEN COALESCE(done, NOW())
                     ELSE NULL
                 END
                 WHERE id = :id
                   AND author = :author'
            );

            $updateStmt->execute([
                ':done_value' => $done,
                ':id' => $itemId,
                ':author' => $userId,
            ]);

            $resultStmt = $pdo->prepare(
                'SELECT done
                 FROM erp_dayplanner_items
                 WHERE id = ?
                   AND author = ?
                 LIMIT 1'
            );

            $resultStmt->execute([
                $itemId,
                $userId,
            ]);

            $result = $resultStmt->fetch(PDO::FETCH_ASSOC);

            return [
                'status' => 'ok',
                'id' => $itemId,
                'done' => is_array($result)
                    ? $result['done']
                    : null,
            ];
        }
    );
}

function erp_dayplanner_reorder(
    PDO $pdo,
    array $input,
    array $user
): array {
    $userId = (int)$user['id'];
    $date = erp_dayplanner_validate_date(
        $pdo,
        (string)($input['date'] ?? '')
    );
    $rawIds = $input['ids'] ?? null;

    if (!is_array($rawIds) || count($rawIds) > 100) {
        throw new ErpHttpException(
            'Некорректный порядок задач',
            422
        );
    }

    $ids = [];
    $seen = [];

    foreach ($rawIds as $rawId) {
        $id = (int)$rawId;

        if ($id <= 0 || isset($seen[$id])) {
            throw new ErpHttpException(
                'Некорректный порядок задач',
                422
            );
        }

        $seen[$id] = true;
        $ids[] = $id;
    }

    return erp_transaction(
        $pdo,
        function () use (
            $pdo,
            $userId,
            $date,
            $ids
        ): array {
            $lockStmt = $pdo->prepare(
                'SELECT id
                 FROM erp_dayplanner_items
                 WHERE author = ?
                   AND task_date = ?
                 ORDER BY weight ASC, id ASC
                 FOR UPDATE'
            );

            $lockStmt->execute([
                $userId,
                $date,
            ]);

            $storedIds = array_map(
                static fn (array $row): int => (int)$row['id'],
                $lockStmt->fetchAll(PDO::FETCH_ASSOC)
            );

            $sortedStored = $storedIds;
            $sortedSubmitted = $ids;

            sort($sortedStored, SORT_NUMERIC);
            sort($sortedSubmitted, SORT_NUMERIC);

            if ($sortedStored !== $sortedSubmitted) {
                throw new ErpHttpException(
                    'Список был изменён. Обновите страницу задач',
                    409
                );
            }

            if ($ids !== []) {
                $caseParts = [];
                $parameters = [];

                foreach ($ids as $position => $id) {
                    $caseParts[] = 'WHEN ? THEN ?';
                    $parameters[] = $id;
                    $parameters[] = ($position + 1) * 10;
                }

                $idPlaceholders = implode(
                    ',',
                    array_fill(0, count($ids), '?')
                );

                $parameters[] = $userId;
                $parameters[] = $date;

                foreach ($ids as $id) {
                    $parameters[] = $id;
                }

                $updateStmt = $pdo->prepare(
                    'UPDATE erp_dayplanner_items
                     SET weight = CASE id '
                        . implode(' ', $caseParts)
                        . ' ELSE weight END
                     WHERE author = ?
                       AND task_date = ?
                       AND id IN (' . $idPlaceholders . ')'
                );

                $updateStmt->execute($parameters);
            }

            return [
                'status' => 'ok',
                'date' => $date,
                'ids' => $ids,
            ];
        }
    );
}

function erp_dayplanner_fetch_items(
    PDO $pdo,
    int $userId,
    string $date
): array {
    $stmt = $pdo->prepare(
        'SELECT
            id,
            client_id,
            text,
            weight,
            created,
            done
         FROM erp_dayplanner_items
         WHERE author = ?
           AND task_date = ?
         ORDER BY weight ASC, id ASC
         LIMIT 100'
    );

    $stmt->execute([
        $userId,
        $date,
    ]);

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $items = [];

    foreach ($rows as $row) {
        $items[] = [
            'id' => (int)$row['id'],
            'clientId' => (string)$row['client_id'],
            'text' => (string)$row['text'],
            'weight' => (int)$row['weight'],
            'created' => (string)$row['created'],
            'done' => $row['done'] !== null
                ? (string)$row['done']
                : null,
        ];
    }

    return $items;
}

function erp_dayplanner_fetch_dates(
    PDO $pdo,
    int $userId,
    string $today
): array {
    $stmt = $pdo->prepare(
        'SELECT DISTINCT task_date
         FROM erp_dayplanner_items
         WHERE author = ?
           AND task_date <= ?
         ORDER BY task_date DESC'
    );

    $stmt->execute([
        $userId,
        $today,
    ]);

    $dates = [$today => true];

    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $date) {
        $dates[(string)$date] = true;
    }

    $result = array_keys($dates);
    rsort($result, SORT_STRING);

    return $result;
}

function erp_dayplanner_validate_date(
    PDO $pdo,
    string $value
): string {
    $value = trim($value);

    $date = DateTimeImmutable::createFromFormat(
        '!Y-m-d',
        $value
    );

    $errors = DateTimeImmutable::getLastErrors();

    if (
        !$date
        || ($errors !== false
            && (
                $errors['warning_count'] > 0
                || $errors['error_count'] > 0
            ))
        || $date->format('Y-m-d') !== $value
    ) {
        throw new ErpHttpException(
            'Некорректная дата',
            422
        );
    }

    $today = erp_dayplanner_current_date($pdo);

    if ($value > $today) {
        throw new ErpHttpException(
            'Нельзя открыть будущую дату',
            422
        );
    }

    return $value;
}

function erp_dayplanner_current_date(PDO $pdo): string
{
    $stmt = $pdo->query(
        'SELECT CURDATE()'
    );

    $value = $stmt->fetchColumn();

    if (!is_string($value) || $value === '') {
        throw new ErpHttpException(
            'Не удалось определить текущую дату',
            500
        );
    }

    return $value;
}

function erp_dayplanner_string_length(string $value): int
{
    if (function_exists('mb_strlen')) {
        return mb_strlen($value, 'UTF-8');
    }

    $matches = preg_match_all(
        '/./us',
        $value,
        $characters
    );

    if ($matches === false) {
        throw new ErpHttpException(
            'Текст содержит некорректные символы',
            422
        );
    }

    return $matches;
}