import lodash, { Dictionary } from 'lodash';
import { v1 as neo4j } from 'neo4j-driver';
import {
  print,
  parse,
  GraphQLOutputType,
  GraphQLResolveInfo,
  SelectionNode,
  FragmentDefinitionNode,
  FieldNode,
  InlineFragmentNode,
  GraphQLNonNull,
  GraphQLList,
  GraphQLNamedType
} from 'graphql';

function parseArg(arg, variableValues) {
  switch (arg.value.kind) {
    case 'IntValue': {
      return parseInt(arg.value.value);
    }
    case 'FloatValue': {
      return parseFloat(arg.value.value);
    }
    case 'Variable': {
      return variableValues[arg.value.name.value];
    }
    case 'ObjectValue': {
      return parseArgs(arg.value.fields, variableValues);
    }
    case 'ListValue': {
      return lodash.map(arg.value.values, value => parseArg({ value }, variableValues));
    }
    case 'NullValue': {
      return null;
    }
    default: {
      return arg.value.value;
    }
  }
}

export function parseArgs(args, variableValues) {
  if (!args || args.length === 0) {
    return {};
  }
  return args.reduce((acc, arg) => {
    acc[arg.name.value] = parseArg(arg, variableValues);
    return acc;
  }, {});
}

export const parseFieldSdl = sdl => {
  return sdl ? parse(`type Type { ${sdl} }`).definitions[0].fields[0] : {};
};

export const parseInputFieldSdl = sdl => {
  return sdl ? parse(`input Type { ${sdl} }`).definitions[0].fields : {};
};

export const buildInputValueDefinitions = fields => {
  let arr = [];
  if (Array.isArray(fields)) {
    fields = fields.join('\n');
    arr = fields ? parse(`type Type { ${fields} }`).definitions[0].fields : [];
    arr = arr.map(e => ({
      kind: 'InputValueDefinition',
      name: e.name,
      type: e.type
    }));
  }
  return arr;
};

export const parseDirectiveSdl = sdl => {
  return sdl ? parse(`type Type { field: String ${sdl} }`).definitions[0].fields[0].directives[0] : {};
};

export const printTypeMap = typeMap => {
  return print({
    kind: 'Document',
    definitions: Object.values(typeMap)
  });
};

export const extractTypeMapFromTypeDefs = typeDefs => {
  // TODO accept alternative typeDefs formats (arr of strings, ast, etc.)
  // into a single string for parse, add validatation
  const astNodes = parse(typeDefs).definitions;
  return astNodes.reduce((acc, t) => {
    if (t.name) acc[t.name.value] = t;
    return acc;
  }, {});
};

export function extractSelections(
  selections: readonly SelectionNode[],
  fragments: { [index: string]: FragmentDefinitionNode }
): Array<FieldNode | InlineFragmentNode> {
  return selections.reduce((acc: Array<FieldNode | InlineFragmentNode>, cur) => {
    // Check if a fragment is being spread in the selection: like object { ...ObjectFragment }
    if (cur.kind === 'FragmentSpread' && fragments[cur.name.value].selectionSet.selections) {
      // Recursively look up the fields that have to be selected from the fragment.
      const recursivelyExtractedSelections = extractSelections(
        fragments[cur.name.value].selectionSet.selections,
        fragments
      );
      return acc.concat(recursivelyExtractedSelections);
    }
    acc.push(cur as FieldNode | InlineFragmentNode);
    return acc;
  }, []);
}

export function extractQueryResult({ records }, returnType) {
  const { variableName } = typeIdentifiers(returnType);
  let result = null;
  if (isArrayType(returnType)) {
    result = records.map(record => record.get(variableName));
  } else if (records.length) {
    // could be object or scalar
    result = records[0].get(variableName);
    result = Array.isArray(result) ? result[0] : result;
  }
  // handle Integer fields
  result = lodash.cloneDeepWith(result, field => {
    if (neo4j.isInt(field)) {
      // See: https://neo4j.com/docs/api/javascript-driver/current/class/src/v1/integer.js~Integer.html
      return field.inSafeRange() ? field.toNumber() : field.toString();
    }
  });
  return result;
}

export function typeIdentifiers(returnType: GraphQLOutputType) {
  const typeName = innerType(returnType).toString();
  return { typeName, variableName: lowFirstLetter(typeName) };
}

function getDefaultArguments(fieldName, schemaType) {
  // get default arguments for this field from schema
  try {
    return schemaType._fields[fieldName].args.reduce((acc, arg) => {
      acc[arg.name] = arg.defaultValue;
      return acc;
    }, {});
  } catch (err) {
    return {};
  }
}

export function cypherDirectiveArgs(variable, headSelection, cypherParams, schemaType, resolveInfo, paramIndex) {
  // Get any default arguments or an empty object
  const defaultArgs = getDefaultArguments(headSelection.name.value, schemaType);
  // Set the $this parameter by default
  let args = [`this: ${variable}`];
  // If cypherParams are provided, add the parameter
  if (cypherParams) args.push(`cypherParams: $cypherParams`);
  // Parse field argument values
  const queryArgs = parseArgs(headSelection.arguments, resolveInfo.variableValues);
  // Add arguments that have default values, if no value is provided
  Object.keys(defaultArgs).forEach(e => {
    // Use only if default value exists and no value has been provided
    if (defaultArgs[e] !== undefined && queryArgs[e] === undefined) {
      // Values are inlined
      const inlineDefaultValue = JSON.stringify(defaultArgs[e]);
      args.push(`${e}: ${inlineDefaultValue}`);
    }
  });
  // Add arguments that have provided values
  Object.keys(queryArgs).forEach(e => {
    if (queryArgs[e] !== undefined) {
      // Use only if value exists
      args.push(`${e}: $${paramIndex}_${e}`);
    }
  });
  // Return the comma separated join of all param
  // strings, adding a comma to match current test formats
  return args.join(', ');
}

export function isGraphqlScalarType(type) {
  return type.constructor.name === 'GraphQLScalarType' || type.constructor.name === 'GraphQLEnumType';
}

export function isArrayType(type) {
  return type ? type.toString().startsWith('[') : false;
}

export const isRelationTypeDirectedField = fieldName => {
  return fieldName === 'from' || fieldName === 'to';
};

export const isKind = (type, kind) => type && type.kind && type.kind === kind;

export const _isListType = (type, isList = false) => {
  if (!isKind(type, 'NamedType')) {
    if (isKind(type, 'ListType')) isList = true;
    return _isListType(type.type, isList);
  }
  return isList;
};

export const isNonNullType = (type, isRequired = false, parent = {}) => {
  if (!isKind(type, 'NamedType')) {
    return isNonNullType(type.type, isRequired, type);
  }
  if (isKind(parent, 'NonNullType')) {
    isRequired = true;
  }
  return isRequired;
};

export const isBasicScalar = name => {
  return name === 'ID' || name === 'String' || name === 'Float' || name === 'Int' || name === 'Boolean';
};

export const isNodeType = astNode => {
  return (
    astNode &&
    // must be graphql object type
    astNode.kind === 'ObjectTypeDefinition' &&
    // is not Query or Mutation type
    astNode.name.value !== 'Query' &&
    astNode.name.value !== 'Mutation' &&
    // does not have relation type directive
    getTypeDirective(astNode, 'relation') === undefined &&
    // does not have from and to fields; not relation type
    astNode.fields &&
    astNode.fields.find(e => e.name.value === 'from') === undefined &&
    astNode.fields.find(e => e.name.value === 'to') === undefined
  );
};

export const isRelationTypePayload = schemaType => {
  const astNode = schemaType ? schemaType.astNode : undefined;
  const directive = astNode ? getRelationTypeDirective(astNode) : undefined;
  return astNode && astNode.fields && directive
    ? astNode.fields.find(e => {
        return e.name.value === directive.from || e.name.value === directive.to;
      })
    : undefined;
};

export const isRootSelection = ({ selectionInfo, rootType }) => selectionInfo && selectionInfo.rootType === rootType;

export const lowFirstLetter = (word: string): string => word.charAt(0).toLowerCase() + word.slice(1);

const hasOfType = (type: any): type is GraphQLList<any> => type.ofType;

export function innerType(type: GraphQLOutputType): GraphQLOutputType {
  if (hasOfType(type)) return innerType(type.ofType);
  return type;
}

export function filtersFromSelections(selections, variableValues) {
  if (selections && selections.length && selections[0].arguments && selections[0].arguments.length) {
    return selections[0].arguments.reduce((result, x) => {
      (result[x.name.value] = argumentValue(selections[0], x.name.value, variableValues)) || x.value.value;
      return result;
    }, {});
  }
  return {};
}

export function innerFilterParams(
  filters: Dictionary<any>,
  paramKey?: string | null,
  cypherDirective: boolean = false
) {
  // don't exclude first, offset, orderBy args for cypher directives
  const excludedKeys = cypherDirective ? [] : ['first', 'offset', 'orderBy', 'filter'];
  return Object.entries(filters)
    .filter(([key]) => !excludedKeys.includes(key))
    .map(([key, value]) => {
      return { key, paramKey, value };
    });
}

export function paramsToString(params) {
  if (params.length > 0) {
    const strings = params.map(param => {
      return `${param.key}:${param.paramKey ? `$${param.paramKey}.` : '$'}${
        typeof param.value.index === 'undefined' ? param.key : `${param.value.index}_${param.key}`
      }`;
    });
    return `{${strings.join(', ')}}`;
  }
  return '';
}

export function computeSkipLimit(selection, variableValues) {
  let first = argumentValue(selection, 'first', variableValues);
  let offset = argumentValue(selection, 'offset', variableValues);

  if (first === null && offset === null) return '';
  if (offset === null) return `[..${first}]`;
  if (first === null) return `[${offset}..]`;
  return `[${offset}..${parseInt(offset) + parseInt(first)}]`;
}

function splitOrderByArg(orderByVar) {
  const splitIndex = orderByVar.lastIndexOf('_');
  const order = orderByVar.substring(splitIndex + 1);
  const orderBy = orderByVar.substring(0, splitIndex);
  return { orderBy, order };
}

function orderByStatement(resolveInfo, { orderBy, order }) {
  const { variableName } = typeIdentifiers(resolveInfo.returnType);
  return ` ${variableName}.${orderBy} ${order === 'asc' ? 'ASC' : 'DESC'} `;
}

export const computeOrderBy = (resolveInfo: GraphQLResolveInfo, schemaType: GraphQLNamedType) => {
  let selection = resolveInfo.operation.selectionSet.selections[0];
  const orderByArgs = argumentValue(selection, 'orderBy', resolveInfo.variableValues);
  if (!orderByArgs) return { cypherPart: '', optimization: { earlyOrderBy: false } };

  const orderByArray = Array.isArray(orderByArgs) ? orderByArgs : [orderByArgs];

  let optimization = { earlyOrderBy: true };
  let orderByStatements = [];

  const orderByStatments = orderByArray.map(orderByVar => {
    const { orderBy, order } = splitOrderByArg(orderByVar);
    const hasNoCypherDirective = lodash.isEmpty(cypherDirective(schemaType, orderBy));
    optimization.earlyOrderBy = optimization.earlyOrderBy && hasNoCypherDirective;
    orderByStatements.push(orderByStatement(resolveInfo, { orderBy, order }));
  });

  return {
    cypherPart: ` ORDER BY${orderByStatements.join(',')}`,
    optimization
  };
};

export const getQueryArguments = (resolveInfo: GraphQLResolveInfo) => {
  if (!resolveInfo.schema) throw new Error('neo4j-graphql: No schema has been found');
  const queryType = resolveInfo.schema.getQueryType();
  if (!queryType) throw new Error('neo4j-graphql: No Query Type has been found');
  const { astNode } = queryType.getFields()[resolveInfo.fieldName];
  if (!astNode) throw new Error(`neo4j-graphql: No astNode found for fieldname: ${resolveInfo.fieldName}`);
  return astNode.arguments;
};

// TODO refactor to handle Query/Mutation type schema directives
const directiveWithArgs = (directiveName, args) => (schemaType, fieldName) => {
  function fieldDirective(schemaType, fieldName, directiveName) {
    return !isGraphqlScalarType(schemaType)
      ? schemaType.getFields() &&
          schemaType.getFields()[fieldName] &&
          schemaType.getFields()[fieldName].astNode.directives.find(e => e.name.value === directiveName)
      : {};
  }

  function directiveArgument(directive, name) {
    return directive && directive.arguments ? directive.arguments.find(e => e.name.value === name).value.value : [];
  }

  const directive = fieldDirective(schemaType, fieldName, directiveName);
  const ret = {};
  if (directive) {
    Object.assign(
      ret,
      ...args.map(key => ({
        [key]: directiveArgument(directive, key)
      }))
    );
  }
  return ret;
};

export const cypherDirective = directiveWithArgs('cypher', ['statement']);

export const relationDirective = directiveWithArgs('relation', ['name', 'direction']);

export const getTypeDirective = (relatedAstNode, name) => {
  return relatedAstNode && relatedAstNode.directives
    ? relatedAstNode.directives.find(e => e.name.value === name)
    : undefined;
};

export const getFieldDirective = (field, directive) => {
  return field && field.directives && field.directives.find(e => e && e.name && e.name.value === directive);
};

export const getRelationDirection = relationDirective => {
  let direction = {};
  try {
    direction = relationDirective.arguments.filter(a => a.name.value === 'direction')[0];
    return direction.value.value;
  } catch (e) {
    // FIXME: should we ignore this error to define default behavior?
    throw new Error('No direction argument specified on @relation directive');
  }
};

export const getRelationName = relationDirective => {
  let name = {};
  try {
    name = relationDirective.arguments.filter(a => a.name.value === 'name')[0];
    return name.value.value;
  } catch (e) {
    // FIXME: should we ignore this error to define default behavior?
    throw new Error('No name argument specified on @relation directive');
  }
};

export const addDirectiveDeclarations = (typeMap, config) => {
  // overwrites any provided directive declarations for system directive names
  typeMap['cypher'] = parse(`directive @cypher(statement: String) on FIELD_DEFINITION`).definitions[0];
  typeMap['relation'] = parse(
    `directive @relation(name: String, direction: _RelationDirections, from: String, to: String) on FIELD_DEFINITION | OBJECT`
  ).definitions[0];
  // TODO should we change these system directives to having a '_Neo4j' prefix
  typeMap['MutationMeta'] = parse(
    `directive @MutationMeta(relationship: String, from: String, to: String) on FIELD_DEFINITION`
  ).definitions[0];
  typeMap['neo4j_ignore'] = parse(`directive @neo4j_ignore on FIELD_DEFINITION`).definitions[0];
  typeMap['_RelationDirections'] = parse(`enum _RelationDirections { IN OUT }`).definitions[0];
  typeMap = possiblyAddDirectiveDeclarations(typeMap, config);
  return typeMap;
};

export const getQueryCypherDirective = (resolveInfo: GraphQLResolveInfo) => {
  if (!resolveInfo || !resolveInfo.schema) throw new Error('neo4j-graphql: No schema has been found');
  const queryType = resolveInfo.schema.getQueryType();
  if (!queryType) throw new Error('neo4j-graphql: No Query Type has been found');
  const { astNode } = queryType.getFields()[resolveInfo.fieldName];
  if (!astNode) throw new Error(`neo4j-graphql: No astNode found for fieldname: ${resolveInfo.fieldName}`);
  // If node has no directives return nothing.
  if (!astNode.directives) return;
  return astNode.directives.find(x => {
    return x.name.value === 'cypher';
  });
};

function argumentValue(selection, name, variableValues) {
  let arg = selection.arguments.find(a => a.name.value === name);
  if (!arg) {
    return null;
  } else {
    return parseArg(arg, variableValues);
  }
}

export const getRelationTypeDirective = relationshipType => {
  const directive =
    relationshipType && relationshipType.directives
      ? relationshipType.directives.find(e => e.name.value === 'relation')
      : undefined;
  return directive
    ? {
        name: directive.arguments.find(e => e.name.value === 'name').value.value,
        from: directive.arguments.find(e => e.name.value === 'from').value.value,
        to: directive.arguments.find(e => e.name.value === 'to').value.value
      }
    : undefined;
};

export const getRelationMutationPayloadFieldsFromAst = relatedAstNode => {
  let isList = false;
  let fieldName = '';
  return relatedAstNode.fields
    .reduce((acc, t) => {
      fieldName = t.name.value;
      if (fieldName !== 'to' && fieldName !== 'from') {
        isList = _isListType(t);
        // Use name directly in order to prevent requiring required fields on the payload type
        acc.push(
          `${fieldName}: ${isList ? '[' : ''}${_getNamedType(t).name.value}${isList ? `]` : ''}${print(t.directives)}`
        );
      }
      return acc;
    }, [])
    .join('\n');
};

export const _getNamedType = type => {
  if (type.kind !== 'NamedType') {
    return _getNamedType(type.type);
  }
  return type;
};

const firstNonNullAndIdField = fields => {
  let valueTypeName = '';
  return fields.find(e => {
    valueTypeName = _getNamedType(e).name.value;
    return e.name.value !== '_id' && e.type.kind === 'NonNullType' && valueTypeName === 'ID';
  });
};

const firstIdField = fields => {
  let valueTypeName = '';
  return fields.find(e => {
    valueTypeName = _getNamedType(e).name.value;
    return e.name.value !== '_id' && valueTypeName === 'ID';
  });
};

const firstNonNullField = fields => {
  let valueTypeName = '';
  return fields.find(e => {
    valueTypeName = _getNamedType(e).name.value;
    return valueTypeName === 'NonNullType';
  });
};

const firstField = fields => {
  return fields.find(e => {
    return e.name.value !== '_id';
  });
};

export const getPrimaryKey = astNode => {
  let fields = astNode.fields;
  let pk = undefined;
  // remove all ignored fields
  fields = fields.filter(field => !getFieldDirective(field, 'neo4j_ignore'));
  if (!fields.length) return pk;
  pk = firstNonNullAndIdField(fields);
  if (!pk) {
    pk = firstIdField(fields);
  }
  if (!pk) {
    pk = firstNonNullField(fields);
  }
  if (!pk) {
    pk = firstField(fields);
  }
  return pk;
};

export const createOperationMap = type => {
  const fields = type ? type.fields : [];
  return fields.reduce((acc, t) => {
    acc[t.name.value] = t;
    return acc;
  }, {});
};

/**
 * Render safe a variable name according to cypher rules
 * @param {String} i input variable name
 * @returns {String} escaped text suitable for interpolation in cypher
 */
export const safeVar = i => {
  // There are rare cases where the var input is an object and has to be stringified
  // to produce the right output.
  const asStr = `${i}`;

  // Rules: https://neo4j.com/docs/developer-manual/current/cypher/syntax/naming/
  return '`' + asStr.replace(/[-!$%^&*()_+|~=`{}\[\]:";'<>?,.\/]/g, '_') + '`';
};

/**
 * Render safe a label name by enclosing it in backticks and escaping any
 * existing backtick if present.
 * @param {String} l a label name
 * @returns {String} an escaped label name suitable for cypher concat
 */
export const safeLabel = l => {
  const asStr = `${l}`;
  const escapeInner = asStr.replace(/\`/g, '\\`');
  return '`' + escapeInner + '`';
};

export const decideNestedVariableName = ({
  schemaTypeRelation,
  innerSchemaTypeRelation,
  variableName,
  fieldName,
  parentSelectionInfo
}) => {
  if (
    isRootSelection({
      selectionInfo: parentSelectionInfo,
      rootType: 'relationship'
    }) &&
    isRelationTypeDirectedField(fieldName)
  ) {
    return parentSelectionInfo[fieldName];
  } else if (schemaTypeRelation) {
    const fromTypeName = schemaTypeRelation.from;
    const toTypeName = schemaTypeRelation.to;
    if (fromTypeName === toTypeName) {
      if (fieldName === 'from' || fieldName === 'to') {
        return variableName + '_' + fieldName;
      } else {
        // Case of a reflexive relationship type's directed field
        // being renamed to its node type value
        // ex: from: User -> User: User
        return variableName;
      }
    }
  } else {
    // Types without @relation directives are assumed to be node types
    // and only node types can have fields whose values are relation types
    if (innerSchemaTypeRelation) {
      // innerSchemaType is a field payload type using a @relation directive
      if (innerSchemaTypeRelation.from === innerSchemaTypeRelation.to) {
        return variableName;
      }
    } else {
      // related types are different
      return variableName + '_' + fieldName;
    }
  }
  return variableName + '_' + fieldName;
};

export const createSkipLimit = (first: number, offset: number): string => {
  const skip = (offset > 0 && ' SKIP $offset') || '';
  const limit = (first > -1 && ' LIMIT $first') || '';
  return skip + limit;
};

export const getPayloadSelections = (resolveInfo: GraphQLResolveInfo) => {
  const filteredFieldNodes = resolveInfo.fieldNodes.filter(node => node.name.value === resolveInfo.fieldName);
  if (filteredFieldNodes[0] && filteredFieldNodes[0].selectionSet) {
    // FIXME: how to handle multiple fieldNode matches
    const x = extractSelections(filteredFieldNodes[0].selectionSet.selections, resolveInfo.fragments);
    return x;
  }
  return [];
};

export const filterNullParams = ({
  offset,
  first,
  otherParams
}: {
  offset?: number;
  first?: number;
  otherParams: object;
}): [Dictionary<any>, Dictionary<any>] => {
  return Object.entries({
    ...{ offset, first },
    ...otherParams
  }).reduce(
    ([nulls, nonNulls], [key, value]) => {
      if (value === null) nulls[key] = value;
      else nonNulls[key] = value;
      return [nulls, nonNulls];
    },
    [{}, {}] as [Dictionary<any>, Dictionary<any>]
  );
};

// An ignored type is a type without at least 1 non-ignored field
export const excludeIgnoredTypes = (typeMap, config = {}) => {
  const queryExclusionMap = {};
  const mutationExclusionMap = {};
  // If .query is an object and .exclude is provided, use it, else use new arr
  let excludedQueries = getExcludedTypes(config, 'query');
  let excludedMutations = getExcludedTypes(config, 'mutation');
  // Add any ignored types to exclusion arrays
  Object.keys(typeMap).forEach(name => {
    if (typeMap[name].fields && !typeMap[name].fields.find(field => !getFieldDirective(field, 'neo4j_ignore'))) {
      // All fields are ignored, so exclude the type
      excludedQueries.push(name);
      excludedMutations.push(name);
    }
  });
  // As long as the API is still allowed, convert the exclusion arrays
  // to a boolean map for quicker reference later
  if (config.query !== false) {
    excludedQueries.forEach(e => {
      queryExclusionMap[e] = true;
    });
    config.query = { exclude: queryExclusionMap };
  }
  if (config.mutation !== false) {
    excludedMutations.forEach(e => {
      mutationExclusionMap[e] = true;
    });
    config.mutation = { exclude: mutationExclusionMap };
  }
  return config;
};

export const getExcludedTypes = (config, rootType) => {
  return config && rootType && config[rootType] && typeof config[rootType] === 'object' && config[rootType].exclude
    ? config[rootType].exclude
    : [];
};

export const possiblyAddIgnoreDirective = (astNode, typeMap, resolvers, config) => {
  const fields = astNode && astNode.fields ? astNode.fields : [];
  let valueTypeName = '';
  return fields.map(field => {
    // for any field of any type, if a custom resolver is provided
    // but there is no @ignore directive
    valueTypeName = _getNamedType(field).name.value;
    if (
      // has a custom resolver but not a directive
      getCustomFieldResolver(astNode, field, resolvers) &&
      !getFieldDirective(field, 'neo4j_ignore') &&
      // fields that behave in ways specific to the neo4j mapping do not recieve ignore
      // directives and can instead have their data post-processed by a custom field resolver
      !getFieldDirective(field, 'relation') &&
      !getFieldDirective(field, 'cypher') &&
      !getTypeDirective(typeMap[valueTypeName], 'relation')
    ) {
      // possibly initialize directives
      if (!field.directives) field.directives = [];
      // add the ignore directive for use in runtime translation
      field.directives.push(parseDirectiveSdl(`@neo4j_ignore`));
    }
    return field;
  });
};

export const getCustomFieldResolver = (astNode, field, resolvers) => {
  const typeResolver = astNode && astNode.name && astNode.name.value ? resolvers[astNode.name.value] : undefined;
  return typeResolver ? typeResolver[field.name.value] : undefined;
};

export const removeIgnoredFields = (schemaType, selections) => {
  if (!isGraphqlScalarType(schemaType) && selections && selections.length) {
    let schemaTypeField = '';
    selections = selections.filter(e => {
      if (e.kind === 'Field') {
        // so check if this field is ignored
        schemaTypeField = schemaType.getFields()[e.name.value];
        return (
          schemaTypeField && schemaTypeField.astNode && !getFieldDirective(schemaTypeField.astNode, 'neo4j_ignore')
        );
      }
      // keep element by default
      return true;
    });
  }
  return selections;
};
