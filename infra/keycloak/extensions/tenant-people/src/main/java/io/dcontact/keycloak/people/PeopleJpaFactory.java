package io.dcontact.keycloak.people;
import java.util.List;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.connections.jpa.entityprovider.JpaEntityProvider;
import org.keycloak.connections.jpa.entityprovider.JpaEntityProviderFactory;
public class PeopleJpaFactory implements JpaEntityProviderFactory {
  public JpaEntityProvider create(KeycloakSession session) {
    return new JpaEntityProvider() {
      public List<Class<?>> getEntities() { return List.of(TenantGate.class,PeopleOperation.class,PeopleReceipt.class,PeopleInvitationIntent.class,PeopleInvitationDispatch.class,PeopleInvitationFinished.class); }
      public String getChangelogLocation() { return "META-INF/dc-tenant-people-changelog.xml"; }
      public String getFactoryId() { return getId(); }
      public void close() {}
    };
  }
  public String getId() { return "dc-tenant-people-jpa"; }
  public void init(Config.Scope config) {}
  public void postInit(KeycloakSessionFactory factory) {}
  public void close() {}
}
