package io.dcontact.keycloak.account;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import org.keycloak.Config;
import org.keycloak.cookie.CookieProvider;
import org.keycloak.cookie.CookieProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/**
 * R1 (#593) / AC6 (#599): {@link DcCookieProvider} เป็น provider หลักของ SPI {@code cookie} (order สูงกว่า {@code default})
 * — realm ที่ใช้ตั้งด้วย {@code --spi-cookie--dc--realms=dcontact,...} (ค่าเริ่มต้น {@code dcontact})
 */
public class DcCookieProviderFactory implements CookieProviderFactory {

  public static final String ID = "dc";

  private Set<String> realms;

  @Override
  public CookieProvider create(KeycloakSession session) {
    return new DcCookieProvider(session, realms);
  }

  @Override
  public void init(Config.Scope config) {
    String[] configured = config.getArray("realms");
    realms =
        Arrays.stream(configured == null ? new String[] {"dcontact"} : configured)
            .map(String::trim)
            .filter(value -> !value.isEmpty())
            .collect(Collectors.toUnmodifiableSet());
  }

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}

  @Override
  public String getId() {
    return ID;
  }

  @Override
  public int order() {
    return 100;
  }
}
