import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_URL}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'rabar/1.0 script' } });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  const data = await res.json();
  if (!data || data.error) return null;
  console.log(data);
  const a = data.address || {};
  return {
    address: [a.road, a.house_number].filter(Boolean).join(' ') || null,
    city: a.city || a.town || a.village || a.county || null,
  };
}

async function run() {
  const { data: bars } = await supabase.from('bars').select('*').eq('id', '09ab474d-5cab-4d58-bcc9-51cd02feeb85');
  console.log(bars[0]);
  const geo = await reverseGeocode(bars[0].lat, bars[0].lng);
  console.log(geo);
}
run();
