pipeline {
  agent {
    kubernetes {
      defaultContainer 'node'
      yaml """
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: beachsafe-build
spec:
  serviceAccountName: jenkins-deployer
  containers:
  - name: node
    image: node:20-bookworm
    command: [cat]
    tty: true
    resources:
      requests:
        memory: "512Mi"
        cpu: "500m"
      limits:
        memory: "1Gi"
        cpu: "1000m"
  - name: helm
    image: alpine/helm:3.16.3
    command: [cat]
    tty: true
  - name: buildah
    image: quay.io/buildah/stable
    command: [cat]
    tty: true
    securityContext:
      privileged: true
    resources:
      requests:
        memory: "512Mi"
        cpu: "500m"
        ephemeral-storage: "2Gi"
      limits:
        memory: "1Gi"
        cpu: "1000m"
        ephemeral-storage: "8Gi"
    volumeMounts:
    - name: varlibcontainers
      mountPath: /var/lib/containers
  - name: jnlp
    image: jenkins/inbound-agent:latest
  volumes:
  - name: varlibcontainers
    emptyDir:
      sizeLimit: 8Gi
"""
    }
  }

  parameters {
    booleanParam(name: 'DEPLOY_ONLY', defaultValue: false, description: 'Skip build — re-deploy the existing image tag')
    booleanParam(name: 'RESEED', defaultValue: false, description: 'Re-run migrate + seed against platform DB. Only needed when incident JSON files have changed.')
    string(name: 'IMAGE_TAG_OVERRIDE', defaultValue: '', description: 'Override image tag (leave blank to use git SHA)')
  }

  environment {
    // REGISTRY must be set in Jenkins → Manage Jenkins → Configure System
    // → Global properties → Environment variables (e.g. 192.168.1.101:5000 or ghcr.io/your-org)
    // It is intentionally not stored in source control.
    REGISTRY = "${env.REGISTRY}"
    APP_NAME = 'beachsafe'
    NAMESPACE = 'beachsafe'
  }

  stages {
    stage('Setup') {
      steps {
        container('node') {
          script {
            sh 'git config --global --add safe.directory "*"'
            env.IMAGE_TAG = params.IMAGE_TAG_OVERRIDE?.trim()
              ? params.IMAGE_TAG_OVERRIDE.trim()
              : sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
            echo "Image tag: ${env.IMAGE_TAG}"
            sh 'npm install -g pnpm@9'
          }
        }
      }
    }

    stage('Install') {
      when { not { expression { params.DEPLOY_ONLY } } }
      steps {
        container('node') {
          sh 'pnpm install --frozen-lockfile'
        }
      }
    }

    stage('Verify') {
      when { not { expression { params.DEPLOY_ONLY } } }
      steps {
        container('node') {
          sh 'pnpm exec vitest run --reporter=junit --outputFile=test-results.xml'
        }
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'test-results.xml'
        }
      }
    }

    stage('Seed DB') {
      when {
        anyOf {
          expression { params.RESEED }
          expression { currentBuild.number == 1 }
        }
      }
      steps {
        container('node') {
          // Credential ID 'beachsafe-database-url' must exist in Jenkins credential store
          withCredentials([string(credentialsId: 'beachsafe-database-url', variable: 'DATABASE_URL')]) {
            sh 'DATABASE_URL="${DATABASE_URL}" pnpm exec tsx scripts/migrate.ts'
            sh 'DATABASE_URL="${DATABASE_URL}" pnpm exec tsx scripts/etl/run-all.ts --skip-weather --skip-waves --skip-tides --skip-rnli --skip-enrich'
          }
        }
      }
    }

    stage('Build & Push') {
      when { not { expression { params.DEPLOY_ONLY } } }
      steps {
        container('buildah') {
          sh """
            buildah bud \
              --layers \
              -t ${REGISTRY}/${APP_NAME}:${IMAGE_TAG} \
              -t ${REGISTRY}/${APP_NAME}:main \
              .
            buildah push --tls-verify=false ${REGISTRY}/${APP_NAME}:${IMAGE_TAG}
            buildah push --tls-verify=false ${REGISTRY}/${APP_NAME}:main
            buildah rmi ${REGISTRY}/${APP_NAME}:${IMAGE_TAG} || true
            buildah rmi ${REGISTRY}/${APP_NAME}:main || true
          """
        }
      }
    }

    stage('Deploy') {
      steps {
        container('helm') {
          withCredentials([
            // Credential IDs 'beachsafe-database-url' and 'anthropic-api-key' must exist in Jenkins credential store
            string(credentialsId: 'beachsafe-database-url',    variable: 'DATABASE_URL'),
            string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_KEY'),
          ]) {
            sh """
              helm list -n ${NAMESPACE} | grep -q "^${APP_NAME}" && \
              helm history ${APP_NAME} -n ${NAMESPACE} | tail -1 | grep -q "pending" && \
              helm rollback ${APP_NAME} -n ${NAMESPACE} || true

              helm upgrade --install ${APP_NAME} deploy/helm/${APP_NAME} \
                --namespace ${NAMESPACE} --create-namespace \
                --set image.registry="${REGISTRY}" \
                --set image.tag="${IMAGE_TAG}" \
                --set secrets.databaseUrl="${DATABASE_URL}" \
                --set secrets.anthropicApiKey="${ANTHROPIC_KEY}" \
                --set appVersion="${IMAGE_TAG} (#${currentBuild.number})" \
                --wait --timeout 60m
            """
          }
        }
      }
    }
  }

  post {
    always {
      echo "Build #${currentBuild.number} — ${currentBuild.currentResult}"
      container('buildah') {
        sh '''
          buildah rm -a || true
          buildah rmi -a -f || true
        '''
      }
    }
  }
}
