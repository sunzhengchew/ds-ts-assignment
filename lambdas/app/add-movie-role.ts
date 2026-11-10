import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { isResponse, parseJsonObject, response } from "../shared/http";

import {
  actorKey,
  ddb,
  movieKey,
  type Role,
  tableName,
} from "../shared/db";

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

  // Parse the request body and return any JSON parsing error
  const body = parseJsonObject(event);
  if (isResponse(body)) return body;

  // Check that movieId is a positive, safe integer
  if (
    typeof body.movieId !== "number" ||
    !Number.isSafeInteger(body.movieId) ||
    body.movieId <= 0
  ) {
    return response(400, {
      message: "movieId must be a positive integer",
    });
  }

  // Check that actorId is a positive, safe integer.
  if (
    typeof body.actorId !== "number" ||
    !Number.isSafeInteger(body.actorId) ||
    body.actorId <= 0
  ) {
    return response(400, {
      message: "actorId must be a positive integer",
    });
  }


  // Reject a missing role name or one containing only spaces
  if (
    typeof body.roleName !== "string" ||
    body.roleName.trim() === ""
  ) {
    return response(400, {
      message: "roleName must be a non-empty string",
    });
  }
  // Reject a missing description or one containing only spaces
  if (
    typeof body.roleDescription !== "string" ||
    body.roleDescription.trim() === ""
  ) {
    return response(400, {
      message: "roleDescription must be a non-empty string",
    });
  }
  // Create the validated role and remove surrounding spaces
  const role: Role = {
    movieId: body.movieId,
    actorId: body.actorId,
    roleName: body.roleName.trim(),
    roleDescription: body.roleDescription.trim(),
  };



  try {
    // Perform all checks and the write as one transaction.
    // If any condition fails, the role is not saved.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: {
                PK: movieKey(role.movieId),
                SK: movieKey(role.movieId),
              },
              ConditionExpression: "attribute_exists(PK)",
            },
          },

          {
            // Check that the specified actor exists.
            ConditionCheck: {
              TableName: tableName,
              Key: {
                PK: actorKey(role.actorId),
                SK: actorKey(role.actorId),
              },
              ConditionExpression: "attribute_exists(PK)",
            },
          },

          {
            // Save the role using the movie and actor keys.
            Put: {
              TableName: tableName,
              Item: {
                PK: movieKey(role.movieId),
                SK: actorKey(role.actorId),
                ...role,
              },
              // Prevent overwriting an existing movie/actor role
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    // Return model data without exposing DynamoDB keys.
    return response(201, {
      message: "Role added",
      data: role,
    });
  } catch (err) {
     // Identify transaction condition failed
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons;

      // Reasons follow the order of TransactItems above
      if (reasons?.[0]?.Code === "ConditionalCheckFailed") {
        return response(404, { message: "Movie not found" });
      }

      if (reasons?.[1]?.Code === "ConditionalCheckFailed") {
        return response(404, { message: "Actor not found" });
      }

      if (reasons?.[2]?.Code === "ConditionalCheckFailed") {
        return response(409, {
          message: "A role already exists for this actor in this movie",
        });
      }
    }

    console.error("DynamoDB error:", err);

    return response(500, {
      message: "Internal server error",
    });

  }
};