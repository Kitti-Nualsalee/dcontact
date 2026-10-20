package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
@Entity @Table(name="DC_TENANT_PEOPLE_OPERATION")
public class PeopleOperation {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="REALM_ID",nullable=false,length=255) public String realmId;
  @Column(name="CLIENT_ID",nullable=false,length=255) public String clientId;
  @Column(name="OPERATION_ID",nullable=false,length=36) public String operationId;
  @Column(name="TENANT_ID",nullable=false,length=36) public String tenantId;
  @Column(name="TARGET_USER_ID",nullable=false,length=36) public String targetUserId;
  @Column(name="PAYLOAD_DIGEST",nullable=false,length=64) public String payloadDigest;
  @Column(name="REQUEST_DIGEST",nullable=false,length=64) public String requestDigest;
  @Column(name="MAX_FENCE",nullable=false) public long maxFence;
}
