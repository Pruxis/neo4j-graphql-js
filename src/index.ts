import { extractQueryResult, typeIdentifiers, getPayloadSelections } from './utils';
import { translateQuery } from './translate';
import { GraphQLResolveInfo, GraphQLNamedType } from 'graphql';
import { Driver } from 'neo4j-driver/types/v1';
import { Parameters } from './types';

interface Context {
  driver: Driver;
}

export function cypherQuery(parameters: Parameters, context: Context, resolveInfo: GraphQLResolveInfo) {
  const { typeName, variableName } = typeIdentifiers(resolveInfo.returnType);
  const schemaType = resolveInfo.schema.getType(typeName) as GraphQLNamedType;
  const selections = getPayloadSelections(resolveInfo);
  return translateQuery({ resolveInfo, schemaType, selections, variableName, typeName, parameters });
}

export const neo4jgraphql = async (
  _: any,
  params: any,
  context: Context,
  resolveInfo: GraphQLResolveInfo,
  debug = true
) => {
  const [query, cypherParams] = cypherQuery(params, context, resolveInfo);
  if (debug) {
    console.log(query);
    console.log(JSON.stringify(cypherParams, null, 2));
  }
  const session = context.driver.session();
  const result = await session.readTransaction(tx => {
    return tx.run(query, cypherParams);
  });
  session.close();
  return extractQueryResult(result, resolveInfo.returnType);
};
