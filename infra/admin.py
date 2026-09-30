import json
import boto3


def handler(event, context):
    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": event.get("PhysicalResourceId", "pai-admin")}
    p = event["ResourceProperties"]
    login = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId=p["SecretArn"])["SecretString"])
    client = boto3.client("cognito-idp")
    try:
        client.admin_create_user(
            UserPoolId=p["PoolId"], Username=login["username"], MessageAction="SUPPRESS"
        )
    except client.exceptions.UsernameExistsException:
        pass
    client.admin_set_user_password(
        UserPoolId=p["PoolId"], Username=login["username"], Password=login["password"], Permanent=True
    )
    return {"PhysicalResourceId": "pai-admin", "Data": {"Username": login["username"]}}
