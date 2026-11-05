/*
  Antifurto RFID - ESP32 + 2x RC522

  Leitor 1 = PORTAL (saida)  -> backend diz se a tag pode sair
  Leitor 2 = CAIXA           -> so le quando o caixa esta ligado no painel
*/

#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ---------- CONFIG ----------
const char* WIFI_SSID = "SEU_WIFI";
const char* WIFI_PASS = "SUA_SENHA";

const char* BASE_URL   = "https://microcontroladores-eosin.vercel.app";
// ROTAS SUPOSTAS - ajuste para as rotas reais do seu backend:
const char* ROTA_ESTADO = "/api/estado";  // GET: heartbeat + estado do caixa
const char* ROTA_PORTAL = "/api/portal";  // POST: {leitor, uid}
const char* ROTA_CAIXA  = "/api/caixa";   // POST: {leitor, uid, modo}

// SPI compartilhado: SCK=18, MISO=19, MOSI=23
#define PIN_SS_PORTAL 21   // leitor 1
#define PIN_SS_CAIXA  5    // leitor 2
#define PIN_RST       22   // RST compartilhado

#define PIN_BUZZER    25   // buzzer ativo
#define PIN_LED_VERDE 26
#define PIN_LED_VERM  27

const unsigned long INTERVALO_ESTADO = 2000;  // ms
// ----------------------------

MFRC522 portal(PIN_SS_PORTAL, PIN_RST);
MFRC522 caixa(PIN_SS_CAIXA, PIN_RST);

bool caixaLigado = false;
bool modoIdentificar = false;
unsigned long ultimoEstado = 0;

String uidParaString(MFRC522::Uid &uid) {
  String s = "";
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

void conectarWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando ao WiFi");
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWiFi OK" : "\nFalha no WiFi");
}

// Remove espacos para facilitar a busca simples no JSON
String semEspacos(String s) {
  s.replace(" ", "");
  return s;
}

int httpGet(const char* rota, String &resposta) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  WiFiClientSecure client;
  client.setInsecure();  // demo de bancada
  HTTPClient http;
  http.begin(client, String(BASE_URL) + rota);
  int code = http.GET();
  if (code > 0) resposta = semEspacos(http.getString());
  http.end();
  return code;
}

int httpPost(const char* rota, const String &body, String &resposta) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, String(BASE_URL) + rota);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  if (code > 0) resposta = semEspacos(http.getString());
  http.end();
  Serial.printf("POST %s %s -> %d\n", rota, body.c_str(), code);
  return code;
}

// Heartbeat: o painel mostra "ESP32 online" quando isso chega.
// Resposta esperada: {"caixa":true,"identificar":false}
void atualizarEstado() {
  String r;
  int code = httpGet(ROTA_ESTADO, r);
  if (code == 200) {
    caixaLigado = r.indexOf("\"caixa\":true") >= 0;
    modoIdentificar = r.indexOf("\"identificar\":true") >= 0;
  }
}

void bipe(int ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

void sinalOk() {
  digitalWrite(PIN_LED_VERDE, HIGH);
  bipe(100);
  delay(400);
  digitalWrite(PIN_LED_VERDE, LOW);
}

void alarme() {
  digitalWrite(PIN_LED_VERM, HIGH);
  for (int i = 0; i < 6; i++) {
    bipe(250);
    delay(150);
  }
  digitalWrite(PIN_LED_VERM, LOW);
}

bool lerTag(MFRC522 &r, String &uid) {
  if (!r.PICC_IsNewCardPresent() || !r.PICC_ReadCardSerial()) return false;
  uid = uidParaString(r.uid);
  r.PICC_HaltA();
  r.PCD_StopCrypto1();
  return true;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_VERM, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  SPI.begin();
  portal.PCD_Init();
  caixa.PCD_Init();
  Serial.print("Portal: "); portal.PCD_DumpVersionToSerial();
  Serial.print("Caixa:  "); caixa.PCD_DumpVersionToSerial();

  conectarWiFi();
  Serial.println("Sistema pronto.");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();

  if (millis() - ultimoEstado >= INTERVALO_ESTADO) {
    ultimoEstado = millis();
    atualizarEstado();
  }

  String uid;

  // PORTAL (leitor 1): o backend responde se pode sair.
  // Resposta esperada: {"alarme":true} ou {"alarme":false}
  if (lerTag(portal, uid)) {
    Serial.println("[portal] tag " + uid);
    String r;
    String body = "{\"leitor\":1,\"uid\":\"" + uid + "\"}";
    int code = httpPost(ROTA_PORTAL, body, r);
    bool dispara = (code != 200) || (r.indexOf("\"alarme\":true") >= 0);
    // se a requisicao falhar, dispara o alarme por seguranca
    if (dispara) alarme(); else sinalOk();
  }

  // CAIXA (leitor 2): so le quando ligado pelo painel
  if (caixaLigado && lerTag(caixa, uid)) {
    Serial.println("[caixa] tag " + uid);
    String r;
    String modo = modoIdentificar ? "identificar" : "pagar";
    String body = "{\"leitor\":2,\"uid\":\"" + uid + "\",\"modo\":\"" + modo + "\"}";
    int code = httpPost(ROTA_CAIXA, body, r);
    if (code == 200) sinalOk(); else bipe(600);
  }
}