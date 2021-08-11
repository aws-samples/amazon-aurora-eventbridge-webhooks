CREATE TABLE IF NOT EXISTS tenant (
    tenantId int PRIMARY KEY generated always AS identity
);

CREATE TABLE IF NOT EXISTS widget (
    widgetId int PRIMARY KEY generated always AS identity,
    tenantId int NOT NULL,
    CONSTRAINT fk_widget_tenant FOREIGN KEY (tenantId) REFERENCES tenant(tenantId),
    widget_name varchar(255) NOT NULL,
    creation_date timestamp DEFAULT CURRENT_DATE
);

INSERT INTO
    tenant DEFAULT VALUES;

CREATE extension IF NOT EXISTS aws_commons;

CREATE extension IF NOT EXISTS aws_lambda;

CREATE OR REPLACE PROCEDURE create_widget(tenant int, widget_name varchar) 
AS $$

DECLARE cur_date date := CURRENT_DATE;
DECLARE id int;

BEGIN
INSERT INTO
    widget (tenantId, widget_name)
VALUES
    (tenant, widget_name);

SELECT
    lastval() INTO id;

PERFORM *
FROM
    aws_lambda.invoke(
        aws_commons.create_lambda_function_arn(
            '<REPLACE_WITH_AWS_LAMBDA_FUNCTION_ARN'
        ),
        (
            SELECT
                json_build_object(
                    'id',
                    id,
                    'tenantId',
                    cast(tenant AS varchar),
                    'name',
                    widget_name,
                    'creation_date',
                    cur_date
                )
        ) :: json
    );

END;

$$ 
language 'plpgsql';