const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'petshop.db'));
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'America/Sao_Paulo';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const JSON_LIMIT = process.env.JSON_LIMIT || '100kb';
const ALLOWED_STATUSES = ['Aguardando', 'Em Banho', 'Pronto', 'Entregue', 'Cancelado', 'Reagendado'];
const MAX_TEXT_LENGTH = 5000;

const db = new sqlite3.Database(DB_PATH);
let httpServer = null;
let shuttingDown = false;

function corsOptions() {
    if (CORS_ORIGIN === '*') return { origin: '*' };
    const allowed = CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
    return {
        origin(origin, callback) {
            if (!origin || allowed.includes(origin)) return callback(null, true);
            return callback(new Error('Origem não permitida pelo CORS'));
        }
    };
}

app.disable('x-powered-by');
app.use(cors(corsOptions()));
app.use(express.json({ limit: JSON_LIMIT }));

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) return reject(error);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function transaction(callback) {
    return run('BEGIN IMMEDIATE')
        .then(() => Promise.resolve().then(callback))
        .then(async (result) => {
            await run('COMMIT');
            return result;
        })
        .catch(async (error) => {
            try { await run('ROLLBACK'); } catch (_) { /* mantém o erro original */ }
            throw error;
        });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

async function tableColumns(table) {
    const rows = await all(`PRAGMA table_info(${table})`);
    return new Set(rows.map((row) => row.name));
}

async function addColumnIfMissing(table, column, definition) {
    const columns = await tableColumns(table);
    if (!columns.has(column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function initializeDatabase() {
    await run('PRAGMA foreign_keys = ON');
    await run('PRAGMA busy_timeout = 5000');
    await run('PRAGMA journal_mode = WAL');
    await run(`
        CREATE TABLE IF NOT EXISTS tutores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            telefone TEXT NOT NULL,
            cpf TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(`
        CREATE TABLE IF NOT EXISTS pets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tutor_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            especie TEXT DEFAULT 'Cão',
            raca TEXT,
            porte TEXT,
            observacoes TEXT,
            FOREIGN KEY (tutor_id) REFERENCES tutores(id) ON DELETE CASCADE
        )
    `);
    await run(`
        CREATE TABLE IF NOT EXISTS agendamentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pet_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            hora TEXT NOT NULL,
            servico TEXT NOT NULL,
            status TEXT DEFAULT 'Aguardando',
            valor REAL DEFAULT 0.0,
            observacoes TEXT,
            FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
        )
    `);
    await run('CREATE INDEX IF NOT EXISTS idx_pets_tutor_id ON pets(tutor_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_tutores_nome ON tutores(nome)');
    await run('CREATE INDEX IF NOT EXISTS idx_tutores_telefone ON tutores(telefone)');
    await run('CREATE INDEX IF NOT EXISTS idx_agendamentos_data_hora ON agendamentos(data, hora)');
    await run('CREATE INDEX IF NOT EXISTS idx_agendamentos_data_status ON agendamentos(data, status)');
    await run('CREATE INDEX IF NOT EXISTS idx_agendamentos_pet_id ON agendamentos(pet_id)');

    // Migrações aditivas: colunas/tabelas existentes nunca são removidas ou reescritas.
    await addColumnIfMissing('pets', 'data_nascimento', 'TEXT');
    await addColumnIfMissing('pets', 'peso', 'REAL');
    await addColumnIfMissing('pets', 'alergias', 'TEXT');
    await addColumnIfMissing('pets', 'historico_medico', 'TEXT');
    await addColumnIfMissing('agendamentos', 'duracao_minutos', 'INTEGER DEFAULT 60');
    await addColumnIfMissing('agendamentos', 'service_id', 'INTEGER');
    await addColumnIfMissing('agendamentos', 'preco_snapshot', 'REAL');
    await addColumnIfMissing('agendamentos', 'reagendado_de_id', 'INTEGER');
    await addColumnIfMissing('agendamentos', 'lembrete_enviado_em', 'DATETIME');

    await run(`
        CREATE TABLE IF NOT EXISTS servicos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL UNIQUE,
            descricao TEXT,
            duracao_minutos INTEGER NOT NULL DEFAULT 60,
            preco REAL NOT NULL DEFAULT 0,
            ativo INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Seed inicial do catálogo (para evitar “sumir” serviços padrão).
    // Se o catálogo já tiver itens, não duplica (INSERT OR IGNORE pela UNIQUE(none)).
    const defaultServices = [
        { nome: 'Banho', preco: 45 },
        { nome: 'Tosa higiênica', preco: 35 },
        { nome: 'Tosa completa', preco: 70 },
        { nome: 'Banho + tosa', preco: 95 },
        { nome: 'Hidratação', preco: 25 },
        { nome: 'Desembolo', preco: 30 },
    ];

    // Garante que o catálogo padrão exista mesmo que a tabela já tenha outros serviços.
    // INSERT OR IGNORE respeita a UNIQUE(nome) e não sobrescreve preços/descrições.
    for (const s of defaultServices) {
        await run(
            `INSERT OR IGNORE INTO servicos (nome, descricao, duracao_minutos, preco, ativo)
             VALUES (?, ?, ?, ?, 1)`,
            [
                s.nome,
                'Serviço de cuidado e bem-estar para seu pet.',
                60,
                s.preco
            ]
        );
    }
    await run(`
        CREATE TABLE IF NOT EXISTS pet_historico (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pet_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            descricao TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
        )
    `);
    await run(`
        CREATE TABLE IF NOT EXISTS pagamentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agendamento_id INTEGER NOT NULL,
            valor REAL NOT NULL,
            metodo TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Pago',
            pago_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            observacoes TEXT,
            referencia TEXT,
            FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id) ON DELETE CASCADE
        )
    `);
    await addColumnIfMissing('pagamentos', 'motivo', 'TEXT');
    await run(`
        CREATE TABLE IF NOT EXISTS lembretes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agendamento_id INTEGER,
            pet_id INTEGER,
            mensagem TEXT NOT NULL,
            enviar_em TEXT NOT NULL,
            enviado_em DATETIME,
            status TEXT NOT NULL DEFAULT 'Pendente',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id) ON DELETE CASCADE,
            FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
        )
    `);
    await run('CREATE INDEX IF NOT EXISTS idx_pet_historico_pet_id ON pet_historico(pet_id, data)');
    await run('CREATE INDEX IF NOT EXISTS idx_pagamentos_agendamento_id ON pagamentos(agendamento_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_lembretes_enviar_em ON lembretes(enviar_em, status)');
}

const databaseReady = initializeDatabase().catch((error) => {
    console.error('Erro ao inicializar o banco de dados:', error.message);
    throw error;
});

app.use((req, res, next) => {
    databaseReady.then(() => next()).catch(next);
});

function cleanDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function text(value, field, { required = false, max = MAX_TEXT_LENGTH } = {}) {
    const normalized = value === null || value === undefined ? '' : String(value).trim();
    if (required && !normalized) throw validationError(`O campo ${field} é obrigatório.`, field);
    if (normalized.length > max) throw validationError(`O campo ${field} excede ${max} caracteres.`, field);
    return normalized || null;
}

function validationError(message, field = null) {
    const error = new Error(message);
    error.statusCode = 422;
    if (field) error.fields = { [field]: message };
    return error;
}

function parseId(value, field = 'id') {
    if (!/^\d+$/.test(String(value || '')) || Number(value) < 1) {
        throw validationError(`O ${field} deve ser um número inteiro positivo.`, field);
    }
    return Number(value);
}

function parseDate(value, field = 'data') {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationError(`A ${field} deve estar no formato AAAA-MM-DD.`, field);
    const [year, month, day] = date.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
        throw validationError(`A ${field} não é válida.`, field);
    }
    return date;
}

function parseTime(value, field = 'hora') {
    const time = String(value || '');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw validationError(`A ${field} deve estar no formato HH:MM.`, field);
    return time;
}

function parseMoney(value) {
    if (value === '' || value === null || value === undefined) return 0;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw validationError('O valor deve ser um número maior ou igual a zero.', 'valor');
    return amount;
}

function parseStatus(value) {
    if (!ALLOWED_STATUSES.includes(value)) throw validationError(`Status inválido. Use: ${ALLOWED_STATUSES.join(', ')}.`, 'status');
    return value;
}

function todayInTimeZone() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: APP_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date()).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function handleAsync(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendError(res, error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Erro na API:', error.message);
    return res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : error.message, ...(error.fields ? { fields: error.fields } : {}) });
}

app.get('/healthz', handleAsync(async (req, res) => {
    await get('SELECT 1 AS ok');
    res.json({ status: 'ok', database: 'ok', timeZone: APP_TIME_ZONE, data: todayInTimeZone() });
}));

app.get('/api/tutores', handleAsync(async (req, res) => {
    res.json(await all('SELECT * FROM tutores ORDER BY nome'));
}));

app.get('/api/tutores/:id', handleAsync(async (req, res) => {
    const tutor = await get('SELECT * FROM tutores WHERE id = ?', [parseId(req.params.id)]);
    if (!tutor) return res.status(404).json({ error: 'Tutor não encontrado' });
    res.json(tutor);
}));

app.post('/api/tutores', handleAsync(async (req, res) => {
    const nome = text(req.body.nome, 'nome', { required: true, max: 200 });
    const telefone = cleanDigits(req.body.telefone);
    if (telefone.length < 10 || telefone.length > 11) throw validationError('Telefone deve conter 10 ou 11 dígitos.', 'telefone');
    const cpf = req.body.cpf ? cleanDigits(req.body.cpf) : null;
    if (cpf && cpf.length !== 11) throw validationError('CPF deve conter 11 dígitos.', 'cpf');
    const result = await run('INSERT INTO tutores (nome, telefone, cpf) VALUES (?, ?, ?)', [nome, telefone, cpf]);
    res.status(201).json({ id: result.lastID, nome, telefone, cpf });
}));

app.put('/api/tutores/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const nome = text(req.body.nome, 'nome', { required: true, max: 200 });
    const telefone = cleanDigits(req.body.telefone);
    if (telefone.length < 10 || telefone.length > 11) throw validationError('Telefone deve conter 10 ou 11 dígitos.', 'telefone');
    const cpf = req.body.cpf ? cleanDigits(req.body.cpf) : null;
    if (cpf && cpf.length !== 11) throw validationError('CPF deve conter 11 dígitos.', 'cpf');
    const result = await run('UPDATE tutores SET nome = ?, telefone = ?, cpf = ? WHERE id = ?', [nome, telefone, cpf, id]);
    if (!result.changes) return res.status(404).json({ error: 'Tutor não encontrado' });
    res.json({ success: true, message: 'Tutor atualizado com sucesso' });
}));

app.delete('/api/tutores/:id', handleAsync(async (req, res) => {
    const result = await run('DELETE FROM tutores WHERE id = ?', [parseId(req.params.id)]);
    if (!result.changes) return res.status(404).json({ error: 'Tutor não encontrado' });
    res.json({ success: true, message: 'Tutor deletado com sucesso' });
}));

const petWithTutorQuery = `
    SELECT p.*, t.nome AS tutor_nome, t.telefone AS tutor_telefone
    FROM pets p LEFT JOIN tutores t ON p.tutor_id = t.id
`;

app.get('/api/pets', handleAsync(async (req, res) => {
    res.json(await all(`${petWithTutorQuery} ORDER BY p.nome`));
}));

app.get('/api/pets/:id', handleAsync(async (req, res) => {
    const pet = await get(`${petWithTutorQuery} WHERE p.id = ?`, [parseId(req.params.id)]);
    if (!pet) return res.status(404).json({ error: 'Pet não encontrado' });
    res.json(pet);
}));

// Esta rota precisa vir antes de /api/agendamentos/:id para que "hoje" não seja interpretado como um ID.
app.get('/api/agendamentos/hoje', handleAsync(async (req, res) => {
    res.json(await all(`${appointmentQuery} WHERE a.data = ? ORDER BY a.hora, a.status`, [todayInTimeZone()]));
}));

app.get('/api/agendamentos/:id', handleAsync(async (req, res) => {
    const appointment = await get(`${appointmentQuery} WHERE a.id = ?`, [parseId(req.params.id)]);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json(appointment);
}));

function petFields(body, includeTutor = false) {
    const fields = {
        nome: text(body.nome, 'nome', { required: true, max: 200 }),
        especie: text(body.especie, 'especie', { max: 80 }) || 'Cão',
        raca: text(body.raca, 'raça', { max: 120 }),
        porte: text(body.porte, 'porte', { max: 40 }),
        observacoes: text(body.observacoes, 'observações'),
        data_nascimento: body.data_nascimento ? parseDate(body.data_nascimento, 'data_nascimento') : null,
        peso: body.peso === '' || body.peso === null || body.peso === undefined ? null : Number(body.peso),
        alergias: text(body.alergias, 'alergias'),
        historico_medico: text(body.historico_medico, 'histórico médico')
    };
    if (fields.peso !== null && (!Number.isFinite(fields.peso) || fields.peso < 0)) throw validationError('O peso deve ser um número maior ou igual a zero.', 'peso');
    if (includeTutor) fields.tutor_id = parseId(body.tutor_id, 'tutor_id');
    return fields;
}

app.post('/api/pets', handleAsync(async (req, res) => {
    const fields = petFields(req.body, true);
    if (!await get('SELECT id FROM tutores WHERE id = ?', [fields.tutor_id])) throw validationError('Tutor não encontrado.', 'tutor_id');
    const result = await run('INSERT INTO pets (tutor_id, nome, especie, raca, porte, observacoes, data_nascimento, peso, alergias, historico_medico) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [fields.tutor_id, fields.nome, fields.especie, fields.raca, fields.porte, fields.observacoes, fields.data_nascimento, fields.peso, fields.alergias, fields.historico_medico]);
    res.status(201).json({ id: result.lastID, ...fields });
}));

app.post('/api/pets-com-tutor', handleAsync(async (req, res) => {
    const tutor = {
        nome: text(req.body.tutor?.nome, 'nome do tutor', { required: true, max: 200 }),
        telefone: cleanDigits(req.body.tutor?.telefone),
        cpf: req.body.tutor?.cpf ? cleanDigits(req.body.tutor.cpf) : null
    };
    if (tutor.telefone.length < 10 || tutor.telefone.length > 11) throw validationError('Telefone deve conter 10 ou 11 dígitos.', 'telefone');
    if (tutor.cpf && tutor.cpf.length !== 11) throw validationError('CPF deve conter 11 dígitos.', 'cpf');
    const pet = petFields(req.body.pet, false);

    const result = await transaction(async () => {
        const tutorResult = await run('INSERT INTO tutores (nome, telefone, cpf) VALUES (?, ?, ?)', [tutor.nome, tutor.telefone, tutor.cpf]);
        const petResult = await run('INSERT INTO pets (tutor_id, nome, especie, raca, porte, observacoes, data_nascimento, peso, alergias, historico_medico) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [tutorResult.lastID, pet.nome, pet.especie, pet.raca, pet.porte, pet.observacoes, pet.data_nascimento, pet.peso, pet.alergias, pet.historico_medico]);
        return {
            tutor: { id: tutorResult.lastID, ...tutor },
            pet: { id: petResult.lastID, tutor_id: tutorResult.lastID, ...pet }
        };
    });
    res.status(201).json(result);
}));

app.put('/api/pets/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const fields = petFields(req.body);
    const result = await run('UPDATE pets SET nome = ?, especie = ?, raca = ?, porte = ?, observacoes = ?, data_nascimento = ?, peso = ?, alergias = ?, historico_medico = ? WHERE id = ?', [fields.nome, fields.especie, fields.raca, fields.porte, fields.observacoes, fields.data_nascimento, fields.peso, fields.alergias, fields.historico_medico, id]);
    if (!result.changes) return res.status(404).json({ error: 'Pet não encontrado' });
    res.json({ success: true, message: 'Pet atualizado com sucesso' });
}));

app.delete('/api/pets/:id', handleAsync(async (req, res) => {
    const result = await run('DELETE FROM pets WHERE id = ?', [parseId(req.params.id)]);
    if (!result.changes) return res.status(404).json({ error: 'Pet não encontrado' });
    res.json({ success: true, message: 'Pet deletado com sucesso' });
}));

const appointmentQuery = `
    SELECT a.*, p.nome AS pet_nome, p.especie, p.porte,
           p.observacoes AS pet_observacoes, t.nome AS tutor_nome,
           t.telefone AS tutor_telefone,
           COALESCE((SELECT SUM(pg.valor) FROM pagamentos pg WHERE pg.agendamento_id = a.id AND LOWER(pg.status) = 'pago'), 0) AS valor_pago,
           MAX(0, a.valor - COALESCE((SELECT SUM(pg.valor) FROM pagamentos pg WHERE pg.agendamento_id = a.id AND LOWER(pg.status) = 'pago'), 0)) AS saldo_devedor,
           CASE
               WHEN COALESCE((SELECT SUM(pg.valor) FROM pagamentos pg WHERE pg.agendamento_id = a.id AND LOWER(pg.status) = 'pago'), 0) >= a.valor AND a.valor > 0 THEN 'pago'
               WHEN COALESCE((SELECT SUM(pg.valor) FROM pagamentos pg WHERE pg.agendamento_id = a.id AND LOWER(pg.status) = 'pago'), 0) > 0 THEN 'parcial'
               ELSE 'pendente'
           END AS status_pagamento
    FROM agendamentos a
    LEFT JOIN pets p ON a.pet_id = p.id
    LEFT JOIN tutores t ON p.tutor_id = t.id
`;

function appointmentFields(body, requirePet = true) {
    const fields = {
        data: parseDate(body.data),
        hora: parseTime(body.hora),
        servico: text(body.servico, 'serviço', { required: !body.service_id && !body.servico_id, max: 120 }),
        valor: parseMoney(body.valor),
        observacoes: text(body.observacoes, 'observações'),
        duracao_minutos: body.duracao_minutos === '' || body.duracao_minutos === undefined || body.duracao_minutos === null ? 60 : Number(body.duracao_minutos),
        service_id: body.service_id || body.servico_id ? parseId(body.service_id || body.servico_id, 'service_id') : null
    };
    if (!Number.isInteger(fields.duracao_minutos) || fields.duracao_minutos < 1 || fields.duracao_minutos > 1440) throw validationError('A duração deve ser um número inteiro entre 1 e 1440 minutos.', 'duracao_minutos');
    if (requirePet) fields.pet_id = parseId(body.pet_id, 'pet_id');
    return fields;
}

async function resolveAppointmentService(fields, body, existing = null) {
    if (fields.service_id) {
        const service = await get('SELECT * FROM servicos WHERE id = ? AND ativo = 1', [fields.service_id]);
        if (!service) throw validationError('Serviço não encontrado ou inativo.', 'service_id');

        fields.servico = service.nome;
        if (body.duracao_minutos === undefined || body.duracao_minutos === '' || body.duracao_minutos === null) {
            fields.duracao_minutos = service.duracao_minutos;
        }
        const rawValue = body.valor;
        if (rawValue === undefined || rawValue === null || rawValue === '' || Number(rawValue) === 0) {
            fields.valor = service.preco;
        }
        fields.preco_snapshot = fields.valor;
        return fields;
    }

    if (!fields.servico) {
        throw validationError('Informe um serviço do catálogo ou descreva um serviço personalizado.', 'servico');
    }
    fields.service_id = null;
    fields.preco_snapshot = existing && existing.preco_snapshot !== null && existing.preco_snapshot !== undefined
        ? fields.valor
        : fields.valor;
    return fields;
}

async function ensurePetExists(id) {
    if (!await get('SELECT id FROM pets WHERE id = ?', [id])) throw validationError('Pet não encontrado.', 'pet_id');
}

app.get('/api/agendamentos', handleAsync(async (req, res) => {
    const params = [];
    let filter = '';
    if (req.query.data) { params.push(parseDate(req.query.data)); filter = ' WHERE a.data = ?'; }
    res.json(await all(`${appointmentQuery}${filter} ORDER BY a.data DESC, a.hora, a.status`, params));
}));

app.post('/api/agendamentos', handleAsync(async (req, res) => {
    const fields = appointmentFields(req.body);
    await ensurePetExists(fields.pet_id);
    await resolveAppointmentService(fields, req.body);
    const result = await run('INSERT INTO agendamentos (pet_id, data, hora, servico, valor, duracao_minutos, service_id, preco_snapshot, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [fields.pet_id, fields.data, fields.hora, fields.servico, fields.valor, fields.duracao_minutos, fields.service_id, fields.preco_snapshot, fields.observacoes]);
    res.status(201).json({ id: result.lastID, ...fields, status: 'Aguardando' });
}));

app.put('/api/agendamentos/:id/status', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const status = parseStatus(req.body.status);
    const result = await run('UPDATE agendamentos SET status = ? WHERE id = ?', [status, id]);
    if (!result.changes) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const appointment = await get(`${appointmentQuery} WHERE a.id = ?`, [id]);
    res.json({ success: true, message: 'Status atualizado com sucesso', appointment });
}));

app.put('/api/agendamentos/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await get('SELECT * FROM agendamentos WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const fields = appointmentFields({ ...existing, ...req.body }, false);
    const serviceWasSubmitted = Object.prototype.hasOwnProperty.call(req.body, 'service_id') || Object.prototype.hasOwnProperty.call(req.body, 'servico_id');
    const valueWasSubmitted = Object.prototype.hasOwnProperty.call(req.body, 'valor');
    if (serviceWasSubmitted || valueWasSubmitted || Object.prototype.hasOwnProperty.call(req.body, 'servico')) {
        await resolveAppointmentService(fields, req.body, existing);
    } else {
        fields.servico = existing.servico;
        fields.valor = existing.valor;
        fields.service_id = existing.service_id;
        fields.preco_snapshot = existing.preco_snapshot === null || existing.preco_snapshot === undefined ? existing.valor : existing.preco_snapshot;
    }
    const result = await run('UPDATE agendamentos SET data = ?, hora = ?, servico = ?, valor = ?, duracao_minutos = ?, service_id = ?, preco_snapshot = ?, observacoes = ? WHERE id = ?', [fields.data, fields.hora, fields.servico, fields.valor, fields.duracao_minutos, fields.service_id, fields.preco_snapshot, fields.observacoes, id]);
    if (!result.changes) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ success: true, message: 'Agendamento atualizado com sucesso', appointment: await get(`${appointmentQuery} WHERE a.id = ?`, [id]) });
}));

app.delete('/api/agendamentos/:id', handleAsync(async (req, res) => {
    const result = await run('DELETE FROM agendamentos WHERE id = ?', [parseId(req.params.id)]);
    if (!result.changes) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json({ success: true, message: 'Agendamento deletado com sucesso' });
}));

// Catálogo de serviços e preços.
function serviceFields(body) {
    const nome = text(body.nome || body.name, 'nome', { required: true, max: 120 });
    const descricao = text(body.descricao || body.description, 'descrição');
    const duracao_minutos = body.duracao_minutos === undefined || body.duracao_minutos === '' ? 60 : Number(body.duracao_minutos);
    if (!Number.isInteger(duracao_minutos) || duracao_minutos < 1 || duracao_minutos > 1440) throw validationError('A duração deve ser um número inteiro entre 1 e 1440 minutos.', 'duracao_minutos');
    const preco = parseMoney(body.preco === undefined ? body.preço : body.preco);
    const ativo = body.ativo === undefined ? 1 : (body.ativo ? 1 : 0);
    return { nome, descricao, duracao_minutos, preco, ativo };
}

app.get('/api/servicos', handleAsync(async (req, res) => {
    const includeInactive = String(req.query.incluir_inativos || req.query.include_inactive || '') === 'true';
    res.json(await all(`SELECT * FROM servicos${includeInactive ? '' : ' WHERE ativo = 1'} ORDER BY nome`));
}));
app.get('/api/servicos/:id', handleAsync(async (req, res) => {
    const service = await get('SELECT * FROM servicos WHERE id = ?', [parseId(req.params.id)]);
    if (!service) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json(service);
}));
app.post('/api/servicos', handleAsync(async (req, res) => {
    const fields = serviceFields(req.body);
    try {
        const result = await run('INSERT INTO servicos (nome, descricao, duracao_minutos, preco, ativo) VALUES (?, ?, ?, ?, ?)', [fields.nome, fields.descricao, fields.duracao_minutos, fields.preco, fields.ativo]);
        res.status(201).json({ id: result.lastID, ...fields });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') throw validationError('Já existe um serviço com esse nome.', 'nome');
        throw error;
    }
}));
app.put('/api/servicos/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const fields = serviceFields(req.body);
    const result = await run('UPDATE servicos SET nome = ?, descricao = ?, duracao_minutos = ?, preco = ?, ativo = ? WHERE id = ?', [fields.nome, fields.descricao, fields.duracao_minutos, fields.preco, fields.ativo, id]);
    if (!result.changes) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json({ success: true, message: 'Serviço atualizado com sucesso' });
}));
app.delete('/api/servicos/:id', handleAsync(async (req, res) => {
    const result = await run('UPDATE servicos SET ativo = 0 WHERE id = ?', [parseId(req.params.id)]);
    if (!result.changes) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json({ success: true, message: 'Serviço desativado com sucesso' });
}));

// Histórico e ficha detalhada do pet.
app.get('/api/pets/:id/perfil', handleAsync(async (req, res) => {
    const petId = parseId(req.params.id, 'pet_id');
    const profile = await get(`${petWithTutorQuery} WHERE p.id = ?`, [petId]);
    if (!profile) return res.status(404).json({ error: 'Pet não encontrado' });
    const cuidados = await all('SELECT descricao FROM pet_historico WHERE pet_id = ? AND tipo IN (\'alergia\', \'cuidado\', \'observação\') ORDER BY data DESC', [petId]);
    res.json({ ...profile, tutor: { id: profile.tutor_id, nome: profile.tutor_nome, telefone: profile.tutor_telefone }, cuidados_especiais: cuidados.map((item) => item.descricao) });
}));

app.get('/api/pets/:id/historico', handleAsync(async (req, res) => {
    const petId = parseId(req.params.id, 'pet_id');
    await ensurePetExists(petId);
    const manual = await all('SELECT id, pet_id, NULL AS agendamento_id, tipo, descricao, data, created_at FROM pet_historico WHERE pet_id = ?', [petId]);
    const appointments = await all("SELECT id, pet_id, id AS agendamento_id, 'atendimento' AS tipo, servico AS descricao, data, NULL AS created_at FROM agendamentos WHERE pet_id = ?", [petId]);
    res.json([...manual, ...appointments].sort((a, b) => String(b.data).localeCompare(String(a.data)) || b.id - a.id));
}));
app.post('/api/pets/:id/historico', handleAsync(async (req, res) => {
    const petId = parseId(req.params.id, 'pet_id');
    await ensurePetExists(petId);
    const tipo = text(req.body.tipo, 'tipo', { required: true, max: 80 });
    const descricao = text(req.body.descricao, 'descrição', { required: true });
    const data = req.body.data ? parseDate(req.body.data) : todayInTimeZone();
    const result = await run('INSERT INTO pet_historico (pet_id, tipo, descricao, data) VALUES (?, ?, ?, ?)', [petId, tipo, descricao, data]);
    res.status(201).json({ id: result.lastID, pet_id: petId, tipo, descricao, data });
}));
app.delete('/api/pets/:petId/historico/:id', handleAsync(async (req, res) => {
    const result = await run('DELETE FROM pet_historico WHERE id = ? AND pet_id = ?', [parseId(req.params.id), parseId(req.params.petId, 'pet_id')]);
    if (!result.changes) return res.status(404).json({ error: 'Registro do histórico não encontrado' });
    res.json({ success: true, message: 'Registro removido com sucesso' });
}));

// Rebooking: cria novo agendamento e marca o original atomicamente.
app.post('/api/agendamentos/:id/reagendar', handleAsync(async (req, res) => {
    const originalId = parseId(req.params.id);
    const result = await transaction(async () => {
        const original = await get('SELECT * FROM agendamentos WHERE id = ?', [originalId]);
        if (!original) {
            const error = new Error('Agendamento não encontrado');
            error.statusCode = 404;
            throw error;
        }
        const fields = appointmentFields({ ...original, ...req.body }, true);
        await ensurePetExists(fields.pet_id);
        let service = fields.service_id ? await get('SELECT * FROM servicos WHERE id = ? AND ativo = 1', [fields.service_id]) : null;
        if (fields.service_id && !service) throw validationError('Serviço não encontrado ou inativo.', 'service_id');
        // Preserve the original service and financial snapshot unless explicitly overridden.
        fields.service_id = original.service_id;
        fields.servico = original.servico;
        fields.valor = original.preco_snapshot === null || original.preco_snapshot === undefined ? original.valor : original.preco_snapshot;
        fields.duracao_minutos = original.duracao_minutos || fields.duracao_minutos;
        const inserted = await run('INSERT INTO agendamentos (pet_id, data, hora, servico, valor, duracao_minutos, service_id, preco_snapshot, reagendado_de_id, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [fields.pet_id, fields.data, fields.hora, fields.servico, fields.valor, fields.duracao_minutos, fields.service_id, fields.valor, originalId, fields.observacoes]);
        await run("UPDATE agendamentos SET status = 'Reagendado' WHERE id = ?", [originalId]);
        return { id: inserted.lastID, ...fields, preco_snapshot: fields.valor, status: 'Aguardando', reagendado_de: originalId, reagendado_de_id: originalId };
    });
    res.status(201).json(result);
}));
app.post('/api/agendamentos/:id/rebooking', handleAsync(async (req, res, next) => { req.url = req.url.replace('/rebooking', '/reagendar'); next(); }));

// Pagamentos e recibo simples (sem gateway ou dados de cartão).
function paymentFields(body, fallbackAmount = 0) {
    const valor = body.valor === undefined ? parseMoney(fallbackAmount) : parseMoney(body.valor);
    const metodo = text(body.metodo || body.method, 'método', { required: true, max: 40 });
    const status = (text(body.status, 'status', { max: 30 }) || 'pago').toLowerCase();
    if (!['pago', 'pendente', 'estornado', 'cancelado'].includes(status)) throw validationError('Status de pagamento inválido.', 'status');
    return { valor, metodo, status, observacoes: text(body.observacoes, 'observações'), referencia: text(body.referencia, 'referencia', { max: 200 }) };
}

async function paymentSummary(appointmentId) {
    const appointment = await get('SELECT id, valor FROM agendamentos WHERE id = ?', [appointmentId]);
    if (!appointment) return null;
    const paid = await get("SELECT COALESCE(SUM(valor), 0) AS total FROM pagamentos WHERE agendamento_id = ? AND LOWER(status) = 'pago'", [appointmentId]);
    const total = Number(appointment.valor) || 0;
    const valor_pago = Number(paid?.total) || 0;
    return {
        valor_contratado: total,
        valor_pago,
        saldo_devedor: Math.max(0, total - valor_pago),
        status_pagamento: valor_pago >= total && total > 0 ? 'pago' : valor_pago > 0 ? 'parcial' : 'pendente'
    };
}

app.get('/api/agendamentos/:id/pagamentos', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    if (!await get('SELECT id FROM agendamentos WHERE id = ?', [id])) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json(await all('SELECT * FROM pagamentos WHERE agendamento_id = ? ORDER BY pago_em DESC, id DESC', [id]));
}));
app.post('/api/agendamentos/:id/pagamentos', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const appointment = await get('SELECT id, valor FROM agendamentos WHERE id = ?', [id]);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const fields = paymentFields(req.body, appointment.valor);
    const current = await paymentSummary(id);
    if (fields.status === 'pago' && fields.valor > current.saldo_devedor + 0.005) {
        throw validationError(`O pagamento não pode exceder o saldo devedor de ${current.saldo_devedor.toFixed(2)}.`, 'valor');
    }
    const result = await run('INSERT INTO pagamentos (agendamento_id, valor, metodo, status, observacoes, referencia) VALUES (?, ?, ?, ?, ?, ?)', [id, fields.valor, fields.metodo, fields.status, fields.observacoes, fields.referencia]);
    res.status(201).json({ id: result.lastID, agendamento_id: id, ...fields, resumo: await paymentSummary(id) });
}));
app.put('/api/pagamentos/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);

    const oldPayment = await get('SELECT * FROM pagamentos WHERE id = ?', [id]);
    if (!oldPayment) return res.status(404).json({ error: 'Pagamento não encontrado' });

    const appointment = await get('SELECT id, valor FROM agendamentos WHERE id = ?', [oldPayment.agendamento_id]);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado' });

    const motivo = text(req.body.motivo, 'motivo', { required: true, max: 5000 });

    const fields = paymentFields(req.body, oldPayment.valor);

    const paidExcluding = await get(
        "SELECT COALESCE(SUM(pg.valor), 0) AS total FROM pagamentos pg WHERE pg.agendamento_id = ? AND LOWER(pg.status) = 'pago' AND pg.id <> ?",
        [oldPayment.agendamento_id, id]
    );

    const total = Number(appointment.valor) || 0;
    const newPaid = Number(paidExcluding?.total || 0) + (fields.status === 'pago' ? fields.valor : 0);

    if (fields.status === 'pago' && newPaid > total + 0.005) {
        throw validationError(`O pagamento não pode exceder o saldo do atendimento (${total.toFixed(2)}).`, 'valor');
    }

    await run(
        'UPDATE pagamentos SET valor = ?, metodo = ?, status = ?, observacoes = ?, referencia = ?, motivo = ? WHERE id = ?',
        [fields.valor, fields.metodo, fields.status, fields.observacoes, fields.referencia, motivo, id]
    );

    const updated = await get('SELECT * FROM pagamentos WHERE id = ?', [id]);
    const resumo = await paymentSummary(oldPayment.agendamento_id);

    res.json({ success: true, id, ...updated, resumo });
}));

app.post('/api/pagamentos/:id/estornar', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const oldPayment = await get('SELECT * FROM pagamentos WHERE id = ?', [id]);
    if (!oldPayment) return res.status(404).json({ error: 'Pagamento não encontrado' });

    const motivo = text(req.body.motivo, 'motivo', { required: true, max: 5000 });
    const observacoes = req.body.observacoes ? text(req.body.observacoes, 'observações', { max: 5000 }) : oldPayment.observacoes;

    await run('UPDATE pagamentos SET status = ?, motivo = ?, observacoes = ? WHERE id = ?', ['estornado', motivo, observacoes, id]);

    const updated = await get('SELECT * FROM pagamentos WHERE id = ?', [id]);
    const resumo = await paymentSummary(oldPayment.agendamento_id);

    res.json({ success: true, id, ...updated, resumo });
}));

app.get('/api/pagamentos/:id/recibo', handleAsync(async (req, res) => {
    const payment = await get(`SELECT pg.*, a.data, a.hora, a.servico, p.nome AS pet_nome, t.nome AS tutor_nome, t.telefone AS tutor_telefone
        FROM pagamentos pg JOIN agendamentos a ON a.id = pg.agendamento_id JOIN pets p ON p.id = a.pet_id JOIN tutores t ON t.id = p.tutor_id WHERE pg.id = ?`, [parseId(req.params.id)]);
    if (!payment) return res.status(404).json({ error: 'Pagamento não encontrado' });
    res.json({ agendamento_id: payment.agendamento_id, total: payment.valor, pago: payment.valor, saldo: 0, recibo: `REC-${String(payment.id).padStart(6, '0')}`, emitido_em: payment.pago_em, pagamento: payment });
}));
app.get('/api/agendamentos/:id/recibo', handleAsync(async (req, res) => {
    const appointmentId = parseId(req.params.id);
    const appointment = await get(`SELECT a.*, p.nome AS pet_nome, t.nome AS tutor_nome, t.telefone AS tutor_telefone
        FROM agendamentos a JOIN pets p ON p.id = a.pet_id JOIN tutores t ON t.id = p.tutor_id WHERE a.id = ?`, [appointmentId]);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const latestPayment = await get('SELECT * FROM pagamentos WHERE agendamento_id = ? ORDER BY id DESC LIMIT 1', [appointmentId]);
    if (!latestPayment) return res.status(404).json({ error: 'Nenhum pagamento encontrado para o agendamento' });
    const summary = await paymentSummary(appointmentId);
    res.json({ agendamento_id: appointmentId, total: summary.valor_contratado, pago: summary.valor_pago, saldo: summary.saldo_devedor, status_pagamento: summary.status_pagamento, recibo: `REC-${String(latestPayment.id).padStart(6, '0')}`, emitido_em: latestPayment.pago_em, pagamento: { ...latestPayment, ...appointment } });
}));

// Lembretes manuais; o servidor apenas registra e lista, não envia mensagens.
app.get('/api/lembretes', handleAsync(async (req, res) => {
    const status = req.query.status ? text(req.query.status, 'status', { max: 30 }) : null;
    res.json(await all(`SELECT l.*, a.data, a.hora, p.nome AS pet_nome, t.nome AS tutor_nome, t.telefone AS tutor_telefone FROM lembretes l LEFT JOIN agendamentos a ON a.id = l.agendamento_id LEFT JOIN pets p ON p.id = COALESCE(l.pet_id, a.pet_id) LEFT JOIN tutores t ON t.id = p.tutor_id${status ? ' WHERE l.status = ?' : ''} ORDER BY l.enviar_em`, status ? [status] : []));
}));
app.post('/api/lembretes', handleAsync(async (req, res) => {
    const agendamentoId = req.body.agendamento_id ? parseId(req.body.agendamento_id, 'agendamento_id') : null;
    const petId = req.body.pet_id ? parseId(req.body.pet_id, 'pet_id') : null;
    if (!agendamentoId && !petId) throw validationError('Informe agendamento_id ou pet_id.', 'agendamento_id');
    if (agendamentoId && !await get('SELECT id FROM agendamentos WHERE id = ?', [agendamentoId])) return res.status(404).json({ error: 'Agendamento não encontrado' });
    if (petId && !await get('SELECT id FROM pets WHERE id = ?', [petId])) return res.status(404).json({ error: 'Pet não encontrado' });
    const mensagem = text(req.body.mensagem || `Lembrete do agendamento ${agendamentoId || ''}`.trim(), 'mensagem', { required: true });
    const enviarEm = req.body.enviar_em || req.body.enviarEm;
    if (!enviarEm || Number.isNaN(Date.parse(enviarEm))) throw validationError('A data de envio do lembrete é inválida.', 'enviar_em');
    const result = await run('INSERT INTO lembretes (agendamento_id, pet_id, mensagem, enviar_em) VALUES (?, ?, ?, ?)', [agendamentoId, petId, mensagem, enviarEm]);
    res.status(201).json({ id: result.lastID, agendamento_id: agendamentoId, pet_id: petId, mensagem, enviar_em: enviarEm, canal: req.body.canal || null, status: 'pendente' });
}));
app.put('/api/lembretes/:id/status', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const status = String(req.body.status || '').toLowerCase();
    if (!['pendente', 'enviado', 'cancelado'].includes(status)) throw validationError('Status de lembrete inválido.', 'status');
    const result = await run('UPDATE lembretes SET status = ?, enviado_em = CASE WHEN ? = \'enviado\' THEN CURRENT_TIMESTAMP ELSE enviado_em END WHERE id = ?', [status, status, id]);
    if (!result.changes) return res.status(404).json({ error: 'Lembrete não encontrado' });
    res.json({ id, status });
}));
app.put('/api/lembretes/:id', handleAsync(async (req, res) => {
    const id = parseId(req.params.id);
    const status = String(req.body.status || '').toLowerCase();
    if (status && !['pendente', 'enviado', 'cancelado'].includes(status)) throw validationError('Status de lembrete inválido.', 'status');
    const result = await run('UPDATE lembretes SET status = COALESCE(?, status), enviado_em = CASE WHEN ? = \'enviado\' THEN CURRENT_TIMESTAMP ELSE enviado_em END, mensagem = COALESCE(?, mensagem) WHERE id = ?', [status || null, status, req.body.mensagem ? text(req.body.mensagem, 'mensagem') : null, id]);
    if (!result.changes) return res.status(404).json({ error: 'Lembrete não encontrado' });
    res.json({ id, status: status || 'pendente' });
}));
app.delete('/api/lembretes/:id', handleAsync(async (req, res) => {
    const result = await run('DELETE FROM lembretes WHERE id = ?', [parseId(req.params.id)]);
    if (!result.changes) return res.status(404).json({ error: 'Lembrete não encontrado' });
    res.json({ success: true, message: 'Lembrete removido com sucesso' });
}));

// Relatórios agregados por período (sem alterar dados).
app.get('/api/relatorios/faturamento', handleAsync(async (req, res) => {
    const inicio = req.query.de ? parseDate(req.query.de, 'de') : (req.query.inicio ? parseDate(req.query.inicio, 'inicio') : '0000-01-01');
    const fim = req.query.ate ? parseDate(req.query.ate, 'ate') : (req.query.fim ? parseDate(req.query.fim, 'fim') : '9999-12-31');
    const rows = await all("SELECT data, COUNT(*) AS atendimentos, COALESCE(SUM(valor), 0) AS faturamento, SUM(CASE WHEN status = 'Entregue' THEN 1 ELSE 0 END) AS concluidos FROM agendamentos WHERE data BETWEEN ? AND ? GROUP BY data ORDER BY data", [inicio, fim]);
    const total = rows.reduce((result, row) => ({ atendimentos: result.atendimentos + row.atendimentos, faturamento: result.faturamento + row.faturamento, concluidos: result.concluidos + row.concluidos }), { atendimentos: 0, faturamento: 0, concluidos: 0 });
    const paid = await get("SELECT COALESCE(SUM(pg.valor), 0) AS total FROM pagamentos pg JOIN agendamentos a ON a.id = pg.agendamento_id WHERE a.data BETWEEN ? AND ? AND LOWER(pg.status) = 'pago'", [inicio, fim]);
    res.json({ periodo: { de: inicio, ate: fim }, inicio, fim, total, total_previsto: total.faturamento, total_pago: paid.total, dias: rows });
}));
app.get('/api/relatorios/servicos', handleAsync(async (req, res) => {
    const inicio = req.query.de ? parseDate(req.query.de, 'de') : (req.query.inicio ? parseDate(req.query.inicio, 'inicio') : '0000-01-01');
    const fim = req.query.ate ? parseDate(req.query.ate, 'ate') : (req.query.fim ? parseDate(req.query.fim, 'fim') : '9999-12-31');
    res.json(await all("SELECT servico, COUNT(*) AS quantidade, COALESCE(SUM(valor), 0) AS faturamento FROM agendamentos WHERE data BETWEEN ? AND ? AND status NOT IN ('Cancelado', 'Reagendado') GROUP BY servico ORDER BY quantidade DESC, servico", [inicio, fim]));
}));
app.get('/api/relatorios/status', handleAsync(async (req, res) => {
    const inicio = req.query.de ? parseDate(req.query.de, 'de') : (req.query.inicio ? parseDate(req.query.inicio, 'inicio') : '0000-01-01');
    const fim = req.query.ate ? parseDate(req.query.ate, 'ate') : (req.query.fim ? parseDate(req.query.fim, 'fim') : '9999-12-31');
    res.json(await all("SELECT status, COUNT(*) AS quantidade, COALESCE(SUM(valor), 0) AS faturamento FROM agendamentos WHERE data BETWEEN ? AND ? GROUP BY status ORDER BY quantidade DESC, status", [inicio, fim]));
}));

app.get('/api/busca', handleAsync(async (req, res) => {
    const termo = String(req.query.termo || '').trim();
    if (!termo) return res.json({ tutores: [], pets: [] });
    const like = `%${termo}%`;
    const numeric = cleanDigits(termo);
    const [tutores, pets] = await Promise.all([
        all('SELECT * FROM tutores WHERE nome LIKE ? OR telefone LIKE ? OR cpf LIKE ?', [like, `%${numeric}%`, like]),
        all('SELECT p.*, t.nome AS tutor_nome FROM pets p LEFT JOIN tutores t ON p.tutor_id = t.id WHERE p.nome LIKE ? OR p.raca LIKE ? OR t.nome LIKE ?', [like, like, like])
    ]);
    res.json({ tutores, pets });
}));

app.get('/api/dashboard/resumo', handleAsync(async (req, res) => {
    const data = todayInTimeZone();
    const total = await get("SELECT COUNT(*) AS total FROM agendamentos WHERE data = ? AND status NOT IN ('Cancelado', 'Reagendado')", [data]);
    const ready = await get("SELECT COUNT(*) AS total FROM agendamentos WHERE data = ? AND status = 'Pronto'", [data]);
    const revenue = await get("SELECT COALESCE(SUM(valor), 0) AS total FROM agendamentos WHERE data = ? AND status NOT IN ('Cancelado', 'Reagendado')", [data]);
    const received = await get("SELECT COALESCE(SUM(pg.valor), 0) AS total FROM pagamentos pg JOIN agendamentos a ON a.id = pg.agendamento_id WHERE a.data = ? AND a.status NOT IN ('Cancelado', 'Reagendado') AND LOWER(pg.status) = 'pago'", [data]);
    res.json({
        totalAtendimentos: Number(total?.total || 0),
        petsProntos: Number(ready?.total || 0),
        faturamento: Number(revenue?.total || 0),
        faturamentoTotalDia: Number(revenue?.total || 0),
        recebidoHoje: Number(received?.total || 0),
        data
    });
}));

app.get('/api/financeiro/resumo', handleAsync(async (req, res) => {
    const summary = await get(`
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'Entregue' THEN 1 ELSE 0 END), 0) AS concluidos,
            COALESCE(SUM(valor), 0) AS previsto
        FROM agendamentos
    `);
    const received = await get("SELECT COALESCE(SUM(valor), 0) AS total FROM pagamentos WHERE LOWER(status) = 'pago'");
    res.json({
        total: Number(summary?.total || 0),
        concluidos: Number(summary?.concluidos || 0),
        recebido: Number(received?.total || 0),
        previsto: Number(summary?.previsto || 0)
    });
}));

// Backup do banco de dados (SQLite)
app.get('/api/backup/sqlite', (req, res) => {
    try {
        const filePath = DB_PATH;
        if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Banco de dados não encontrado.' });

        res.setHeader('Cache-Control', 'no-store');
        res.download(filePath, path.basename(filePath), (err) => {
            if (err && !res.headersSent) {
                res.status(500).json({ error: 'Falha ao preparar download do backup.' });
            }
        });
    } catch (error) {
        res.status(500).json({ error: error?.message || 'Falha ao exportar backup.' });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Não exponha scripts do servidor ou arquivos de teste via HTTP.
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((error, req, res, next) => sendError(res, error));

function startServer() {
    return databaseReady.then(() => new Promise((resolve, reject) => {
        httpServer = app.listen(PORT, () => {
            console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
            console.log(`📁 Banco de dados: ${DB_PATH}`);
            console.log(`🌎 Fuso horário: ${APP_TIME_ZONE}`);
            resolve(httpServer);
        });
        httpServer.once('error', reject);
    }));
}

function closeDatabase() {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Encerrando servidor (${signal})...`);
    try {
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
        await closeDatabase();
        process.exit(0);
    } catch (error) {
        console.error('Erro ao encerrar servidor:', error.message);
        process.exit(1);
    }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
    startServer().catch((error) => {
        console.error('Não foi possível iniciar o servidor:', error.message);
        process.exit(1);
    });
}

module.exports = { app, startServer, closeDatabase, databaseReady, todayInTimeZone, DB_PATH };
