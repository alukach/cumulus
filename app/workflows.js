'use strict';

/**
 * Provides access to access ingest workflows running in AWS step functions.
 */

/*eslint no-console: ["error", { allow: ["error"] }] */

const { s3, stepFunctions } = require('./aws');
const yaml = require('js-yaml');
const { BadRequestError, handleError } = require('./api-errors');
const { fromJS, Map, List } = require('immutable');

const COLLECTIONS_YAML = 'ingest/collections.yml';

/**
 * getStateMachineArn - Returns the ARN of the state machine for the given stack with the given id.
 *
 * @param  stackName The name of the stack
 * @param  { id }    A workflow with an id.
 * @return ARN of the statemachine in AWS.
 */
async function getStateMachineArn(stackName, { id }) {
  const deployedPrefix = `${stackName}xx${id}`.replace(/-/g, 'x');
  const resp = await stepFunctions().listStateMachines().promise();
  return resp.stateMachines.filter(s => s.name.startsWith(deployedPrefix))[0].stateMachineArn;
}

/**
 * getExecutions - Returns the most recent executions of the given workflow
 *
 * @param  stackName     Name of the AWS stack.
 * @param  workflow      The workflow containing an id
 * @param  numExecutions The number of executions to return at most.
 * @return a list of executions for the workflow with status and start and stop dates.
 */
async function getExecutions(stackName, workflow, numExecutions) {
  const arn = await getStateMachineArn(stackName, workflow);
  const resp = await stepFunctions()
    .listExecutions({ stateMachineArn: arn, maxResults: numExecutions })
    .promise();

  const executions = resp.executions;
  return List(executions.map((e) => {
    const m = Map(
      { status: e.status,
        start_date: e.startDate });
    if (e.stopDate) {
      return m.set('stop_date', e.stopDate);
    }
    return m;
  }));
}

/**
 * getCollectionsYaml - Fetches the collections yaml from S3.
 *
 * @param stackName Name of the step functions deployment stack.
 */
async function getCollectionsYaml(stackName) {
  try {
    const resp = await s3().getObject(
      { Bucket: `${stackName}-deploy`,
        Key: COLLECTIONS_YAML }).promise();
    return resp.Body.toString();
  }
  catch (error) {
    if (error.code === 'NoSuchBucket') {
      throw new BadRequestError(`Stack name [${stackName}] does not appear to exist`);
    }
    throw error;
  }
}

/**
 * Parses the collection yaml into a Immutable JS javascript object.
 */
const parseCollectionYaml = (collectionsYaml) => {
  const resourceType = new yaml.Type('!GitcResource', {
    kind: 'scalar'
  });
  const schema = yaml.Schema.create([resourceType]);
  return fromJS(yaml.safeLoad(collectionsYaml, { schema: schema }));
};

/**
 * getWorkflowStatuses - Returns a list of workflow status results. These include the workflow id,
 * name, and execution information.
 *
 * @param  stackName     The name of the deployed cloud formation stack with AWS state machines.
 * @param  numExecutions The number of executions to return per workflow.
 */
async function getWorkflowStatuses(stackName, numExecutions) {
  const collectionsYaml = await getCollectionsYaml(stackName);
  const parsedYaml = parseCollectionYaml(collectionsYaml);

  const workflows = parsedYaml.get('workflows')
    .entrySeq()
    .map(([k, v]) => Map({ id: k, name: v.get('Comment') }));

  // Request the executions for each workflow. We don't do separate waiting so that they'll
  // execute in parallel.
  const executionPromises = workflows.map(w => getExecutions(stackName, w, numExecutions));
  // We use Promise.all to wait on all of the parallel requests.
  const executionArrays = await Promise.all(executionPromises);

  return workflows.map((w, idx) => {
    const executions = executionArrays[idx];
    return w.set('executions', executions);
  }).toJS();
}

/**
 * handleWorkflowStatusRequest - Handles the API request for workflow statuses.
 */
function handleWorkflowStatusRequest(req, res) {
  req.checkQuery('stack_name', 'Invalid stack_name').notEmpty();
  req.checkQuery('num_executions', 'Invalid num_executions').isInt({ min: 1, max: 1000 });
  req.getValidationResult().then((result) => {
    if (!result.isEmpty()) {
      res.status(400).json(result.array());
    }
    else {
      const stackName = req.query.stack_name;
      const numExecutions = req.query.num_executions;

      getWorkflowStatuses(stackName, numExecutions)
      .then((statuses) => {
        res.json(statuses);
      })
      .catch((err) => {
        handleError(err, req, res);
      });
    }
  });
}

module.exports = { parseCollectionYaml,
  getWorkflowStatuses,
  handleWorkflowStatusRequest };
