// Supabase > Project Settings > API sayfasından kopyalayıp buraya yapıştır.
// "anon public" anahtarı tarayıcıda görünmesi güvenlidir; veriyi giriş (RLS) korur.
window.APP_CONFIG = {
  SUPABASE_URL: "https://ihzpvyhnpqhtbvcxneid.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloenB2eWhucHFodGJ2Y3huZWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NDczOTAsImV4cCI6MjEwOTAyMzM5MH0.8DGEijh7xoRyNporylHSBwOksgvoUFShMIYbXGepxUQ",

  // İSTEĞE BAĞLI: Girişsiz kullanım. İkisini de doldurursanız uygulama kendiliğinden giriş yapar.
  // DİKKAT: Bu dosya herkese açık bir depoda durur; şifreyi görebilen herkes verinize erişebilir.
  // Sadece bu uygulamaya özel, başka hiçbir yerde kullanmadığınız bir şifre kullanın.
  AUTO_LOGIN_EMAIL: "",
  AUTO_LOGIN_PASSWORD: "",
};
