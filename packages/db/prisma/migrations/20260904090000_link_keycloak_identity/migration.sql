-- เชื่อม identity ของ Keycloak กับ user domain record โดยไม่เก็บ tenant identity จาก client
ALTER TABLE "users" ADD COLUMN "keycloak_id" UUID;

CREATE UNIQUE INDEX "users_keycloak_id_key" ON "users"("keycloak_id");
