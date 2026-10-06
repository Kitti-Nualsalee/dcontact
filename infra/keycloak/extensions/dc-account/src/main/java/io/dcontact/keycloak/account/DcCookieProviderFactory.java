package io.dcontact.keycloak.account;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.keycloak.Config;
import org.keycloak.cookie.CookieProvider;
import org.keycloak.cookie.CookieProviderFactory;
import org.keycloak.cookie.CookieType;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/**
 * R1 (#593) prototype: {@link DcCookieProvider} เป็น provider หลักของ SPI {@code cookie}
 * (order สูงกว่า {@code default}) — realm ที่ใช้ตั้งด้วย {@code --spi-cookie--dc--realms=dcontact,...}
 */
public class DcCookieProviderFactory implements CookieProviderFactory {

  public static final String ID = "dc";

  private Map<CookieType, CookieType> renamed;
  private Set<String> realms;

  @Override
  public CookieProvider create(KeycloakSession session) {
    return new DcCookieProvider(session, renamed, realms);
  }

  @Override
  public void init(Config.Scope config) {
    renamed = DcCookieProvider.renameAll();
    realms =
        Arrays.stream(config.getArray("realms") == null ? new String[] {"dcontact"} : config.getArray("realms"))
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
