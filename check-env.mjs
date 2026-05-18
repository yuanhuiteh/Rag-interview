import 'dotenv/config';
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASS:', process.env.DB_PASS === '' ? 'EMPTY' : (process.env.DB_PASS || 'UNDEFINED'));
