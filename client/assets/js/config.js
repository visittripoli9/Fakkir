// FAKKIR public client configuration.
// The Supabase publishable key is safe to use in browser apps when Row Level Security policies are configured correctly.
window.FAKKIR_CONFIG = {
  supabaseUrl: 'https://umraawstqyqfmkyacqfz.supabase.co',
  supabaseAnonKey: 'sb_publishable_Fe98o0FqpYIrgOb7YH25XA_2vNb6Ih5',
  apiBase: '/api',
  preferSupabase: true,
  fallbackToLocal: true,
  defaultTheme: 'light',
  // accounts that get admin powers (must match the `admins` table seeded in
  // server/sql/admin-role.sql). Not a secret — it just declares who is admin;
  // the real enforcement is the database RLS policies.
  adminEmails: ['abedhajjo57@gmail.com']
};
