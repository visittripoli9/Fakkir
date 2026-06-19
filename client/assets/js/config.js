// FAKKIR public client configuration.
// The Supabase publishable key is safe to use in browser apps when Row Level Security policies are configured correctly.
window.FAKKIR_CONFIG = {
  supabaseUrl: 'https://umraawstqyqfmkyacqfz.supabase.co',
  supabaseAnonKey: 'sb_publishable_Fe98o0FqpYIrgOb7YH25XA_2vNb6Ih5',
  apiBase: '/api',
  preferSupabase: true,
  fallbackToLocal: true,
  defaultTheme: 'light',
  // Accounts that see the in-app admin link. Left empty in the public repo to
  // avoid publishing a real email. Add your admin email(s) locally if you want
  // the Settings → admin button to appear, e.g. adminEmails: ['you@example.com'].
  // Real admin access is enforced by the database (admin_users + RLS), not this.
  adminEmails: []
};
