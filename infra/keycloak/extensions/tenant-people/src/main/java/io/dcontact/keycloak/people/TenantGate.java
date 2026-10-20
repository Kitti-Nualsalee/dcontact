package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
@Entity @Table(name="DC_TENANT_PEOPLE_GATE")
public class TenantGate {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="REALM_ID",nullable=false,length=255) public String realmId;
  @Column(name="TENANT_ID",nullable=false,length=36) public String tenantId;
}
