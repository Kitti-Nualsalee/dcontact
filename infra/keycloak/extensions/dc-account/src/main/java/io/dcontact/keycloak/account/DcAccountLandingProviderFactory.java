package io.dcontact.keycloak.account;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.AccountResourceProvider;
import org.keycloak.services.resource.AccountResourceProviderFactory;

/**
 * AC6 (#599): หน้า HTML ของ {@code /realms/dcontact/account/} (Account Console ของ identity provider) ถูกแทนด้วย
 * {@link DcAccountLanding} ที่พาผู้ใช้กลับ D-Contact — เลือกใช้ผ่าน theme property
 * {@code accountResourceProvider=dc-account-landing} ของ account theme {@code dcontact}
 *
 * <p>เป็นจุดขยายที่ Keycloak เปิดไว้ให้ทาง theme; Account REST API ({@code Accept: application/json})
 * ไม่ผ่านจุดนี้ จึงไม่กระทบ {@code @d-contact/i18n} ที่ใช้เปลี่ยนภาษาผ่าน REST
 */
public class DcAccountLandingProviderFactory implements AccountResourceProviderFactory {

  public static final String ID = "dc-account-landing";

  @Override
  public AccountResourceProvider create(KeycloakSession session) {
    return new AccountResourceProvider() {
      @Override
      public Object getResource() {
        return new DcAccountLanding(session);
      }

      @Override
      public void close() {}
    };
  }

  @Override
  public void init(Config.Scope config) {}

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}

  @Override
  public String getId() {
    return ID;
  }
}
