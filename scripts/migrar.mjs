// Aplica las migraciones pendientes (el servidor también lo hace solo al arrancar).
import { migrate, closePool } from '../src/db.js';
const done = await migrate();
console.log(done.length ? `Migraciones aplicadas: ${done.join(', ')}` : 'La base ya estaba al día.');
await closePool();
