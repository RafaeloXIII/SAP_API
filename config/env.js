import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const APP = {
  port: Number(process.env.PORT || 3000),
  apiKey: required('API_KEY'),
};

export const HANA = {
  server: required('HANA_SERVER'),
  port: required('HANA_PORT'),
  uid: required('HANA_UID'),
  pwd: required('HANA_PWD'),
  schema: process.env.HANA_SCHEMA || '',
};