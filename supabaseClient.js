import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import ws from 'ws';

const env = process.env.NODE_ENV || 'dev';
dotenv.config({ path: `.env.${env}` });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(`Credentials fehlen in .env.${env}`);
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { transport: ws }
});